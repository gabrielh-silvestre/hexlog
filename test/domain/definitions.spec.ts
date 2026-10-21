import { describe, it, expect } from '@jest/globals';
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

describe('parseVersion', () => {
  it('should read major and minor as numbers', () => {
    expect(parseVersion('1.10')).toEqual({ major: 1, minor: 10 });
  });

  it.each(['1', '1.0.0', 'a.b', '1.', '.1', '', '01.7', '1.07', '1234567.0', '1.1234567'])(
    'should refuse %j',
    (value) => {
      expect(() => parseVersion(value)).toThrow(HexlogError);
    },
  );

  it.each([
    ['0.0', { major: 0, minor: 0 }],
    ['999999.999999', { major: 999_999, minor: 999_999 }],
  ])('should accept %j', (value, expected) => {
    expect(parseVersion(value)).toEqual(expected);
  });
});

describe('compareVersions', () => {
  it('should compare by number and not by string', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.9', '2.0')).toBeLessThan(0);
    expect(compareVersions('2.3', '2.3')).toBe(0);
  });
});

describe('bumpVersion', () => {
  it('should add one to the minor on a minor bump', () => {
    expect(bumpVersion('1.9', 'minor')).toBe('1.10');
  });

  it('should return the ready version, with a two-digit major', () => {
    expect(bumpVersion('9.9', 'major')).toBe('10.0');
  });

  it('should add one to the major and reset the minor on a major bump', () => {
    expect(bumpVersion('1.9', 'major')).toBe('2.0');
  });
});

describe('classifyTypeChange', () => {
  const base: RecordType = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      level: { type: 'string', enum: ['low', 'high'] },
    },
    required: ['title'],
  };

  it('should classify an identical schema as unchanged', () => {
    expect(classifyTypeChange(base, structuredClone(base))).toBe('unchanged');
  });

  it('should classify a new optional property as compatible', () => {
    const next = {
      ...base,
      properties: { ...(base.properties as object), note: { type: 'string' } },
    };

    expect(classifyTypeChange(base, next)).toBe('compatible');
  });

  it('should classify a new enum value as compatible', () => {
    const next = {
      ...base,
      properties: {
        title: { type: 'string' },
        level: { type: 'string', enum: ['low', 'high', 'mid'] },
      },
    };

    expect(classifyTypeChange(base, next)).toBe('compatible');
  });

  it('should classify a new property that enters required as breaking', () => {
    const next = {
      ...base,
      properties: { ...(base.properties as object), note: { type: 'string' } },
      required: ['title', 'note'],
    };

    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  it('should classify a removed required as breaking', () => {
    expect(classifyTypeChange(base, { ...base, required: [] })).toBe('breaking');
  });

  it('should classify a removed property as breaking', () => {
    const next = { ...base, properties: { title: { type: 'string' } } };

    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  it('should classify a removed enum value as breaking', () => {
    const next = {
      ...base,
      properties: { title: { type: 'string' }, level: { type: 'string', enum: ['low'] } },
    };

    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  it('should classify a changed type as breaking', () => {
    const next = {
      ...base,
      properties: { title: { type: 'number' }, level: { type: 'string', enum: ['low', 'high'] } },
    };

    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  it('should classify an added format as breaking', () => {
    const next = {
      ...base,
      properties: {
        title: { type: 'string', format: 'attachment' },
        level: { type: 'string', enum: ['low', 'high'] },
      },
    };

    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  it.each([
    ['at the root', { ...base, additionalProperties: false }],
    [
      'inside a property',
      {
        ...base,
        properties: {
          title: { type: 'string', minLength: 1 },
          level: { type: 'string', enum: ['low', 'high'] },
        },
      },
    ],
  ])('should classify a new keyword %s as breaking', (_where, next) => {
    expect(classifyTypeChange(base, next)).toBe('breaking');
  });

  it('should not let a property named properties or enum open a keyword exception', () => {
    const before: RecordType = { properties: { properties: { type: 'string' } } };
    const after = { properties: { properties: { type: 'string', minLength: 1 } } };

    expect(classifyTypeChange(before, after)).toBe('breaking');
  });

  // Em `not` e `if` o sentido se inverte: mudança que alarga ali estreita o schema como um todo.
  describe('with positions that narrow the schema', () => {
    it('should classify a widened enum inside not as breaking', () => {
      const before: RecordType = { not: { enum: [1] } };

      expect(classifyTypeChange(before, { not: { enum: [1, 2] } })).toBe('breaking');
    });

    it('should classify a new property in if.properties, with else, as breaking', () => {
      const before: RecordType = {
        if: { properties: { a: { const: 1 } } },
        then: { required: ['t'] },
        else: { required: ['x'] },
      };
      const after = { ...before, if: { properties: { a: { const: 1 }, b: { const: 1 } } } };

      expect(classifyTypeChange(before, after)).toBe('breaking');
    });

    it('should classify a widened enum inside if as breaking', () => {
      const before: RecordType = {
        if: { properties: { a: { enum: [1] } } },
        then: { required: ['t'] },
      };
      const after = { ...before, if: { properties: { a: { enum: [1, 2] } } } };

      expect(classifyTypeChange(before, after)).toBe('breaking');
    });

    it.each(['anyOf', 'allOf', 'oneOf'])(
      'should classify a widened enum inside %s as breaking',
      (keyword) => {
        const before: RecordType = { [keyword]: [{ enum: [1] }] };

        expect(classifyTypeChange(before, { [keyword]: [{ enum: [1, 2] }] })).toBe('breaking');
      },
    );

    const conditional: RecordType = {
      if: { properties: { a: { const: 1 } } },
      then: { properties: { t: { type: 'string' } } },
      else: { properties: { e: { type: 'string' } } },
    };

    // Provado com ajv: nova propriedade em then ou em else recusa o mesmo dado novo que a raiz
    // recusaria, e a raiz já é aceita. Por isso o flag `additive` só cai em if, not e nos arrays.
    it.each([
      [
        'then',
        { ...conditional, then: { properties: { t: { type: 'string' }, n: { type: 'string' } } } },
      ],
      [
        'else',
        { ...conditional, else: { properties: { e: { type: 'string' }, n: { type: 'string' } } } },
      ],
    ])('should classify a new property in %s as compatible, as at the root', (_branch, after) => {
      expect(classifyTypeChange(conditional, after)).toBe('compatible');
    });

    it('should classify a widened enum in properties inside then as compatible', () => {
      const before: RecordType = {
        if: { required: ['a'] },
        then: { properties: { l: { enum: ['x'] } } },
      };
      const after = { ...before, then: { properties: { l: { enum: ['x', 'y'] } } } };

      expect(classifyTypeChange(before, after)).toBe('compatible');
    });

    it('should classify the omc fixture plan with a new property in then as compatible', () => {
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

describe('classifyRelationChange', () => {
  const base: RelationName = { name: 'approves', kind: 'supports', from: ['review'], to: ['doc'] };

  it('should classify an identical definition as unchanged', () => {
    expect(classifyRelationChange(base, { ...base })).toBe('unchanged');
  });

  it('should classify widening from or to as compatible', () => {
    expect(classifyRelationChange(base, { ...base, from: ['review', 'audit'] })).toBe('compatible');
    expect(classifyRelationChange(base, { ...base, to: ['doc', 'spec'] })).toBe('compatible');
  });

  it('should classify removing the list (any type) as widening and compatible', () => {
    expect(classifyRelationChange(base, { name: 'approves', kind: 'supports', to: ['doc'] })).toBe(
      'compatible',
    );
  });

  it('should classify a changed kind as breaking', () => {
    expect(classifyRelationChange(base, { ...base, kind: 'answers' })).toBe('breaking');
  });

  it('should classify narrowing from or to as breaking', () => {
    const wide: RelationName = { ...base, from: ['review', 'audit'], to: ['doc', 'spec'] };

    expect(classifyRelationChange(wide, { ...wide, from: ['review'] })).toBe('breaking');
    expect(classifyRelationChange(wide, { ...wide, to: ['doc'] })).toBe('breaking');
  });

  it('should classify going from no list to a list as breaking', () => {
    const open: RelationName = { name: 'approves', kind: 'supports' };

    expect(classifyRelationChange(open, base)).toBe('breaking');
  });

  it('should classify widening one end and narrowing the other as breaking', () => {
    const next: RelationName = { ...base, from: ['review', 'audit'], to: ['spec'] };

    expect(classifyRelationChange(base, next)).toBe('breaking');
  });
});

describe('attachmentFields', () => {
  it('should find a string field and a list of strings marked with format attachment', () => {
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

  it('should ignore a list whose items lack the mark', () => {
    const schema: RecordType = {
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };

    expect(attachmentFields(schema)).toEqual([]);
  });

  it('should find no attachment field in a schema without properties', () => {
    expect(attachmentFields({ type: 'object' })).toEqual([]);
    expect(attachmentFields({ properties: 'x' })).toEqual([]);
  });

  it('should look only at the first level of properties', () => {
    const schema: RecordType = {
      properties: {
        nested: { type: 'object', properties: { body: { type: 'string', format: 'attachment' } } },
      },
    };

    expect(attachmentFields(schema)).toEqual([]);
  });
});

describe('RecordType', () => {
  /** Objeto cujo JCS tem exatamente `chars` caracteres. */
  function withCanonicalLength(chars: number) {
    const overhead = (canonicalize({ k: '' }) ?? '').length;
    return { k: 'x'.repeat(chars - overhead) };
  }

  it('should accept only a JSON object', () => {
    expect(RecordType.safeParse({ type: 'object' }).success).toBe(true);
    expect(RecordType.safeParse('x').success).toBe(false);
  });

  it('should accept a type only up to the canonical cap', () => {
    const atCap = withCanonicalLength(RECORD_TYPE_MAX_CHARS);

    expect(RECORD_TYPE_MAX_CHARS).toBe(16_000);
    expect((canonicalize(atCap) ?? '').length).toBe(RECORD_TYPE_MAX_CHARS);
    expect(RecordType.safeParse(atCap).success).toBe(true);
    expect(RecordType.safeParse(withCanonicalLength(RECORD_TYPE_MAX_CHARS + 1)).success).toBe(
      false,
    );
  });

  it('should refuse a lone surrogate without throwing', () => {
    expect(RecordType.safeParse({ description: '\ud800' }).success).toBe(false);
  });
});

describe('RelationName', () => {
  it('should require a valid name and kind', () => {
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports' }).success).toBe(true);
    expect(RelationName.safeParse({ name: 'approves', kind: 'nope' }).success).toBe(false);
    expect(RelationName.safeParse({ name: 'Approves', kind: 'supports' }).success).toBe(false);
  });

  it('should refuse an unknown field', () => {
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', extra: 1 }).success).toBe(false);
  });

  // Omitida a ponta aceita qualquer tipo; lista vazia nunca quer dizer "nenhum tipo".
  it.each([
    ['an empty from', { from: [] }],
    ['an empty to', { to: [] }],
    ['a duplicate in from', { from: ['review', 'review'] }],
    ['a duplicate in to', { to: ['doc', 'spec', 'doc'] }],
  ])('should refuse %s', (_label, ends) => {
    expect(RelationName.safeParse({ name: 'approves', kind: 'supports', ...ends }).success).toBe(
      false,
    );
  });

  it('should accept from and to omitted or with distinct names', () => {
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', from: ['x', 'y'] }).success).toBe(
      true,
    );
    expect(RelationName.safeParse({ name: 'a', kind: 'supports', to: ['x'] }).success).toBe(true);
  });

  // Definição é imutável: sem teto, `from`/`to`/`where` gigantes incham o process.json de todo processo novo.
  it('should refuse 100,000 names in from', () => {
    const from = Array.from({ length: 100_000 }, (_, i) => `t${i}`);

    expect(RelationName.safeParse({ name: 'approves', kind: 'supports', from }).success).toBe(
      false,
    );
  });

  // Name tem no máximo 63 caracteres: 200 nomes cabem nos 16.000 canônicos e 260 não.
  it.each([
    { count: 200, accepted: true },
    { count: 260, accepted: false },
  ])(
    'should return success $accepted for $count names of 63 characters in from',
    ({ count, accepted }) => {
      const from = Array.from({ length: count }, (_, i) => String(i).padStart(63, 'a'));

      expect(RelationName.safeParse({ name: 'approves', kind: 'supports', from }).success).toBe(
        accepted,
      );
    },
  );
});

describe('Gate', () => {
  const question = { kind: 'occurred', select: { type: 'review' } };

  it('should refuse a where with 100,000 keys', () => {
    const where = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]));
    const heavy = { kind: 'occurred', select: { type: 'review', where } };

    expect(Gate.safeParse({ name: 'ready', questions: [heavy] }).success).toBe(false);
  });

  it('should accept a small gate with a real where', () => {
    const light = { kind: 'occurred', select: { type: 'review', where: { verdict: 'approved' } } };

    expect(Gate.safeParse({ name: 'ready', questions: [light] }).success).toBe(true);
  });

  it('should require a name and questions with a kind', () => {
    expect(Gate.safeParse({ name: 'ready', questions: [question] }).success).toBe(true);
    expect(Gate.safeParse({ name: 'ready', questions: [{}] }).success).toBe(false);
    expect(Gate.safeParse({ name: 'ready' }).success).toBe(false);
  });

  // Gate vazio nunca barra, e toda mudança de gate é minor: a definição não o admite.
  it('should refuse empty questions', () => {
    expect(Gate.safeParse({ name: 'ready', questions: [] }).success).toBe(false);
  });

  it('should accept questions only up to the cap', () => {
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
