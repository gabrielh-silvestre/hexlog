import { describe, test, expect } from '@jest/globals';
import canonicalize from 'canonicalize';
import { HexlogError } from '../../src/errors.ts';
import {
  GATE_QUESTIONS_MAX,
  Gate,
  RECORD_TYPE_MAX_CHARS,
  RecordType,
  RelationName,
  attachmentFields,
  bumpVersion,
  classifyRelationChange,
  classifyTypeChange,
  compareVersions,
  parseVersion,
} from '../../src/domain/definitions.ts';
import * as omc from '../fixtures/domains/omc.ts';

describe('semver major.minor', () => {
  test('parseVersion lê major e minor como números', () => {
    expect(parseVersion('1.10')).toEqual({ major: 1, minor: 10 });
  });

  test.each(['1', '1.0.0', 'a.b', '1.', '.1', '', '01.7', '1.07', '1234567.0', '1.1234567'])(
    'parseVersion recusa %j',
    (value) => {
      expect(() => parseVersion(value)).toThrow(HexlogError);
    },
  );

  test.each([
    ['0.0', { major: 0, minor: 0 }],
    ['999999.999999', { major: 999_999, minor: 999_999 }],
  ])('parseVersion aceita %j', (value, expected) => {
    expect(parseVersion(value)).toEqual(expected);
  });

  test('compareVersions compara por número e não por string', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.9', '2.0')).toBeLessThan(0);
    expect(compareVersions('2.3', '2.3')).toBe(0);
  });

  test('bumpVersion minor soma ao minor', () => {
    expect(bumpVersion('1.9', 'minor')).toBe('1.10');
  });

  test('bumpVersion devolve a versão pronta, com major de dois dígitos', () => {
    expect(bumpVersion('9.9', 'major')).toBe('10.0');
  });

  test('bumpVersion major soma ao major e zera o minor', () => {
    expect(bumpVersion('1.9', 'major')).toBe('2.0');
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

  // Em `not` e `if` o sentido se inverte: mudança que alarga ali estreita o schema como um todo.
  describe('posições que estreitam o schema (N2)', () => {
    test('enum alargado dentro de not é quebra', () => {
      const before: RecordType = { not: { enum: [1] } };
      expect(classifyTypeChange(before, { not: { enum: [1, 2] } })).toBe('breaking');
    });

    test('propriedade nova em if.properties, com else, é quebra', () => {
      const before: RecordType = {
        if: { properties: { a: { const: 1 } } },
        then: { required: ['t'] },
        else: { required: ['x'] },
      };
      const after = { ...before, if: { properties: { a: { const: 1 }, b: { const: 1 } } } };
      expect(classifyTypeChange(before, after)).toBe('breaking');
    });

    test('enum alargado dentro de if é quebra', () => {
      const before: RecordType = {
        if: { properties: { a: { enum: [1] } } },
        then: { required: ['t'] },
      };
      const after = { ...before, if: { properties: { a: { enum: [1, 2] } } } };
      expect(classifyTypeChange(before, after)).toBe('breaking');
    });

    test('enum alargado dentro de anyOf, allOf e oneOf é quebra', () => {
      for (const keyword of ['anyOf', 'allOf', 'oneOf']) {
        const before: RecordType = { [keyword]: [{ enum: [1] }] };
        expect(classifyTypeChange(before, { [keyword]: [{ enum: [1, 2] }] })).toBe('breaking');
      }
    });

    // Provado com ajv: nova propriedade em then ou em else recusa o mesmo dado novo que a raiz
    // recusaria, e a D-11 já aceita a raiz. Por isso o flag `additive` só cai em if, not e nos arrays.
    test('propriedade nova em then ou em else é compatível, como na raiz', () => {
      const before: RecordType = {
        if: { properties: { a: { const: 1 } } },
        then: { properties: { t: { type: 'string' } } },
        else: { properties: { e: { type: 'string' } } },
      };
      const inThen = {
        ...before,
        then: { properties: { t: { type: 'string' }, n: { type: 'string' } } },
      };
      const inElse = {
        ...before,
        else: { properties: { e: { type: 'string' }, n: { type: 'string' } } },
      };
      expect(classifyTypeChange(before, inThen)).toBe('compatible');
      expect(classifyTypeChange(before, inElse)).toBe('compatible');
    });

    test('enum alargado em properties dentro de then é compatível', () => {
      const before: RecordType = {
        if: { required: ['a'] },
        then: { properties: { l: { enum: ['x'] } } },
      };
      const after = { ...before, then: { properties: { l: { enum: ['x', 'y'] } } } };
      expect(classifyTypeChange(before, after)).toBe('compatible');
    });

    test('o plan do fixture omc com propriedade nova em then é compatível', () => {
      const plan: RecordType = omc.types.plan;
      const next = {
        ...plan,
        then: {
          ...omc.types.plan.then,
          properties: { diff: { type: 'string' }, note: { type: 'string' } },
        },
      };
      expect(classifyTypeChange(plan, next)).toBe('compatible');
    });
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
    const wide: RelationName = { ...base, from: ['review', 'audit'], to: ['doc', 'spec'] };
    expect(classifyRelationChange(wide, { ...wide, from: ['review'] })).toBe('breaking');
    expect(classifyRelationChange(wide, { ...wide, to: ['doc'] })).toBe('breaking');
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
  /** Objeto cujo JCS tem exatamente `chars` caracteres. */
  function withCanonicalLength(chars: number) {
    const overhead = (canonicalize({ k: '' }) ?? '').length;
    return { k: 'x'.repeat(chars - overhead) };
  }

  const question = { kind: 'occurred', select: { type: 'review' } };

  test('RecordType aceita um objeto JSON e recusa o que não é objeto', () => {
    expect(RecordType.safeParse({ type: 'object' }).success).toBe(true);
    expect(RecordType.safeParse('x').success).toBe(false);
  });

  test('RecordType no teto canônico passa e um caractere a mais cai (N8)', () => {
    expect(RECORD_TYPE_MAX_CHARS).toBe(16_000);
    const atCap = withCanonicalLength(RECORD_TYPE_MAX_CHARS);
    expect((canonicalize(atCap) ?? '').length).toBe(RECORD_TYPE_MAX_CHARS);
    expect(RecordType.safeParse(atCap).success).toBe(true);
    expect(RecordType.safeParse(withCanonicalLength(RECORD_TYPE_MAX_CHARS + 1)).success).toBe(
      false,
    );
  });

  test('RecordType com surrogate solitário é recusado sem lançar', () => {
    expect(RecordType.safeParse({ description: '\ud800' }).success).toBe(false);
  });

  test('RelationName exige name e kind válidos e recusa campo estranho', () => {
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports' }).success).toBe(true);
    expect(RelationName.safeParse({ name: 'approves', kind: 'nope' }).success).toBe(false);
    expect(RelationName.safeParse({ name: 'Approves', kind: 'supports' }).success).toBe(false);
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', extra: 1 }).success).toBe(false);
  });

  // Omitida a ponta aceita qualquer tipo; lista vazia nunca quer dizer "nenhum tipo" (N6).
  test.each([
    ['from vazio', { from: [] }],
    ['to vazio', { to: [] }],
    ['from com duplicata', { from: ['review', 'review'] }],
    ['to com duplicata', { to: ['doc', 'spec', 'doc'] }],
  ])('RelationName recusa %s', (_label, ends) => {
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports', ...ends }).success).toBe(
      false,
    );
  });

  test('RelationName aceita from e to omitidos ou com nomes distintos', () => {
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', from: ['x', 'y'] }).success).toBe(
      true,
    );
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', to: ['x'] }).success).toBe(true);
  });

  // Definição é imutável: sem teto, `from`/`to`/`where` gigantes incham o process.json de todo processo novo (N10).
  test('RelationName com 100.000 nomes em from é recusada', () => {
    const from = Array.from({ length: 100_000 }, (_, i) => `t${i}`);
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports', from }).success).toBe(
      false,
    );
  });

  // Name tem no máximo 63 caracteres: 200 nomes cabem nos 16.000 canônicos e 260 não.
  test.each([
    [200, true],
    [260, false],
  ])('RelationName com %i nomes de 63 caracteres em from: aceita=%s', (count, accepted) => {
    const from = Array.from({ length: count }, (_, i) => String(i).padStart(63, 'a'));
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports', from }).success).toBe(
      accepted,
    );
  });

  test('Gate com where de 100.000 chaves é recusado', () => {
    const where = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]));
    const heavy = { kind: 'occurred', select: { type: 'review', where } };
    expect(Gate.safeParse({ name: 'ready', questions: [heavy] }).success).toBe(false);
  });

  test('Gate pequeno com where real é aceito', () => {
    const light = { kind: 'occurred', select: { type: 'review', where: { verdict: 'approved' } } };
    expect(Gate.safeParse({ name: 'ready', questions: [light] }).success).toBe(true);
  });

  test('Gate exige name e perguntas com kind', () => {
    expect(Gate.safeParse({ name: 'ready', questions: [question] }).success).toBe(true);
    expect(Gate.safeParse({ name: 'ready', questions: [{}] }).success).toBe(false);
    expect(Gate.safeParse({ name: 'ready' }).success).toBe(false);
  });

  // Gate vazio nunca barra, e D-11 faz toda mudança de gate ser minor: a definição não o admite.
  test('Gate recusa questions vazio (N5)', () => {
    expect(Gate.safeParse({ name: 'ready', questions: [] }).success).toBe(false);
  });

  test('Gate com perguntas no teto passa e uma a mais cai (N8)', () => {
    const questions = (count: number) => Array.from({ length: count }, () => question);
    expect(GATE_QUESTIONS_MAX).toBe(50);
    expect(
      Gate.safeParse({ name: 'ready', questions: questions(GATE_QUESTIONS_MAX) }).success,
    ).toBe(true);
    expect(
      Gate.safeParse({ name: 'ready', questions: questions(GATE_QUESTIONS_MAX + 1) }).success,
    ).toBe(false);
  });
});
