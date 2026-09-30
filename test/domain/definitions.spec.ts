import { describe, test, expect } from '@jest/globals';
import { HexlogError } from '../../src/errors.ts';
import {
  Gate,
  RecordType,
  RelationName,
  attachmentFields,
  bumpVersion,
  classifyRelationChange,
  classifyTypeChange,
  compareVersions,
  formatVersion,
  parseVersion,
} from '../../src/domain/definitions.ts';

describe('semver major.minor', () => {
  test('parseVersion lê major e minor como números', () => {
    expect(parseVersion('1.10')).toEqual({ major: 1, minor: 10 });
  });

  test.each(['1', '1.0.0', 'a.b', '1.', '.1', ''])('parseVersion recusa %j', (value) => {
    expect(() => parseVersion(value)).toThrow(HexlogError);
  });

  test('formatVersion é o inverso de parseVersion', () => {
    expect(formatVersion(parseVersion('3.7'))).toBe('3.7');
  });

  test('compareVersions compara por número e não por string', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.9', '2.0')).toBeLessThan(0);
    expect(compareVersions('2.3', '2.3')).toBe(0);
  });

  test('bumpVersion minor soma ao minor', () => {
    expect(bumpVersion('1.9', 'minor')).toEqual({ major: 1, minor: 10 });
  });

  test('bumpVersion major soma ao major e zera o minor', () => {
    expect(bumpVersion('1.9', 'major')).toEqual({ major: 2, minor: 0 });
  });
});

describe('classifyTypeChange (D-11)', () => {
  const base: RecordType = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      level: { type: 'string', enum: ['low', 'high'] },
    },
    required: ['title'],
  };

  test('schema idêntico é unchanged', () => {
    expect(classifyTypeChange(base, structuredClone(base))).toBe('unchanged');
  });

  test('propriedade opcional nova é compatível', () => {
    const next = {
      ...base,
      properties: { ...(base.properties as object), note: { type: 'string' } },
    };
    expect(classifyTypeChange(base, next)).toBe('compatible');
  });

  test('valor novo de enum é compatível', () => {
    const next = {
      ...base,
      properties: {
        title: { type: 'string' },
        level: { type: 'string', enum: ['low', 'high', 'mid'] },
      },
    };
    expect(classifyTypeChange(base, next)).toBe('compatible');
  });

  test('propriedade nova que entra em required é quebra', () => {
    const next = {
      ...base,
      properties: { ...(base.properties as object), note: { type: 'string' } },
      required: ['title', 'note'],
    };
    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  test('required removido é quebra', () => {
    expect(classifyTypeChange(base, { ...base, required: [] })).toBe('breaking');
  });

  test('propriedade removida é quebra', () => {
    const next = { ...base, properties: { title: { type: 'string' } } };
    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  test('valor de enum removido é quebra', () => {
    const next = {
      ...base,
      properties: { title: { type: 'string' }, level: { type: 'string', enum: ['low'] } },
    };
    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  test('type trocado é quebra', () => {
    const next = {
      ...base,
      properties: { title: { type: 'number' }, level: { type: 'string', enum: ['low', 'high'] } },
    };
    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  test('format acrescentado é quebra', () => {
    const next = {
      ...base,
      properties: {
        title: { type: 'string', format: 'attachment' },
        level: { type: 'string', enum: ['low', 'high'] },
      },
    };
    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  test('palavra-chave nova em qualquer nível é quebra', () => {
    expect(classifyTypeChange(base, { ...base, additionalProperties: false })).toBe('breaking');
    const next = {
      ...base,
      properties: {
        title: { type: 'string', minLength: 1 },
        level: { type: 'string', enum: ['low', 'high'] },
      },
    };
    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  test('propriedade chamada properties ou enum não abre exceção de palavra-chave', () => {
    const before: RecordType = { properties: { properties: { type: 'string' } } };
    const after = { properties: { properties: { type: 'string', minLength: 1 } } };
    expect(classifyTypeChange(before, after)).toBe('breaking');
  });
});

describe('classifyRelationChange (D-11)', () => {
  const base: RelationName = { name: 'approves', kind: 'supports', from: ['review'], to: ['doc'] };

  test('definição idêntica é unchanged', () => {
    expect(classifyRelationChange(base, { ...base })).toBe('unchanged');
  });

  test('alargar from ou to é compatível', () => {
    expect(classifyRelationChange(base, { ...base, from: ['review', 'audit'] })).toBe('compatible');
    expect(classifyRelationChange(base, { ...base, to: ['doc', 'spec'] })).toBe('compatible');
  });

  test('remover a lista (qualquer tipo) alarga e é compatível', () => {
    expect(classifyRelationChange(base, { name: 'approves', kind: 'supports', to: ['doc'] })).toBe(
      'compatible',
    );
  });

  test('trocar kind é quebra', () => {
    expect(classifyRelationChange(base, { ...base, kind: 'answers' })).toBe('breaking');
  });

  test('estreitar from ou to é quebra', () => {
    const wide: RelationName = { ...base, from: ['review', 'audit'] };
    expect(classifyRelationChange(wide, base)).toBe('breaking');
    expect(classifyRelationChange(wide, { ...wide, to: [] })).toBe('breaking');
  });

  test('passar de sem lista para uma lista é quebra', () => {
    const open: RelationName = { name: 'approves', kind: 'supports' };
    expect(classifyRelationChange(open, base)).toBe('breaking');
  });

  test('alargar uma ponta e estreitar a outra é quebra', () => {
    const next: RelationName = { ...base, from: ['review', 'audit'], to: ['spec'] };
    expect(classifyRelationChange(base, next)).toBe('breaking');
  });
});

describe('attachmentFields (D-16)', () => {
  test('acha campo string e lista de strings marcados com format attachment', () => {
    const schema: RecordType = {
      type: 'object',
      properties: {
        body: { type: 'string', format: 'attachment' },
        extras: { type: 'array', items: { type: 'string', format: 'attachment' } },
        title: { type: 'string' },
        other: { type: 'string', format: 'uri' },
      },
    };
    expect(attachmentFields(schema)).toEqual(['body', 'extras']);
  });

  test('ignora lista cujos itens não têm a marca', () => {
    const schema: RecordType = {
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };
    expect(attachmentFields(schema)).toEqual([]);
  });

  test('schema sem properties não tem campo de anexo', () => {
    expect(attachmentFields({ type: 'object' })).toEqual([]);
    expect(attachmentFields({ properties: 'x' })).toEqual([]);
  });

  test('só olha o primeiro nível de properties', () => {
    const schema: RecordType = {
      properties: {
        nested: { type: 'object', properties: { body: { type: 'string', format: 'attachment' } } },
      },
    };
    expect(attachmentFields(schema)).toEqual([]);
  });
});

describe('schemas de definição', () => {
  test('RecordType aceita um objeto JSON e recusa o que não é objeto', () => {
    expect(RecordType.safeParse({ type: 'object' }).success).toBe(true);
    expect(RecordType.safeParse('x').success).toBe(false);
  });

  test('RelationName exige name e kind válidos e recusa campo estranho', () => {
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports' }).success).toBe(true);
    expect(RelationName.safeParse({ name: 'approves', kind: 'nope' }).success).toBe(false);
    expect(RelationName.safeParse({ name: 'Approves', kind: 'supports' }).success).toBe(false);
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', extra: 1 }).success).toBe(false);
  });

  test('Gate exige name e perguntas com kind', () => {
    const question = { kind: 'occurred', select: { type: 'review' } };
    expect(Gate.safeParse({ name: 'ready', questions: [question] }).success).toBe(true);
    expect(Gate.safeParse({ name: 'ready', questions: [{}] }).success).toBe(false);
    expect(Gate.safeParse({ name: 'ready' }).success).toBe(false);
  });
});
