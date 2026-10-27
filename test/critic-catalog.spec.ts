import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { xor } from 'es-toolkit';
import { z } from 'zod';
import { parseCatalog, renderActions } from '../scripts/flow/critic-catalog.ts';
import { parseJson } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const doc = read('docs/directives/cadeira-do-dono.md');
const premiseSchema = parseJson(
  z.object({ properties: z.object({ actionUsed: z.object({ enum: z.array(z.string()) }) }) }),
  read('.hexlog/types/premise.json'),
);
const actionUsedEnum = premiseSchema.properties.actionUsed.enum;

const ACTIONS_HEADER = '| Ação | Entrada | Saída | Quando é permitida |';
const AVAILABILITY_HEADER = '| Ação | claude-herdr | claude-runner | agy |';
const CHOICE_HEADER = '| Natureza | comum | crítica |';
const HEADERS = [ACTIONS_HEADER, AVAILABILITY_HEADER, CHOICE_HEADER];
const ORDER = '`jury`, `web`, `local`.';

const editTable = (header: string, edit: (lines: string[], at: number) => void): string => {
  const lines = doc.split('\n');
  edit(lines, lines.indexOf(header));
  return lines.join('\n');
};

const coherenceProblems = (
  catalog: ReturnType<typeof parseCatalog>,
  enumValues: string[],
): string[] => {
  const names = Object.keys(catalog.actions);
  const choiceCells = Object.values(catalog.choice).flatMap(({ common, critical }) => [
    common,
    critical,
  ]);
  return [
    xor(enumValues, names).length > 0 ? 'actionUsed enum differs from the catalog actions' : '',
    catalog.order.length !== names.length || xor(catalog.order, names).length > 0
      ? 'cost order is not a permutation of the actions'
      : '',
    choiceCells.some((cell) => !names.includes(cell))
      ? 'choice table cites an action outside the catalog'
      : '',
  ].filter((problem) => problem !== '');
};

describe('parseCatalog', () => {
  describe('with the real owner-seat doc', () => {
    const catalog = parseCatalog(doc);

    it('should return the three actions with input, output and when allowed', () => {
      const filled = {
        input: expect.stringMatching(/\S/),
        output: expect.stringMatching(/\S/),
        allowed: expect.stringMatching(/\S/),
      };

      expect(catalog.actions).toEqual({ local: filled, web: filled, jury: filled });
    });

    it('should return the availability of each action per transport, with a dash for none', () => {
      expect(catalog.availability).toEqual({
        local: { 'claude-herdr': 'explore', 'claude-runner': 'explore', agy: 'próprio' },
        web: {
          'claude-herdr': 'document-specialist',
          'claude-runner': 'document-specialist',
          agy: 'próprio',
        },
        jury: { 'claude-herdr': 'the-jury', 'claude-runner': 'the-jury', agy: '—' },
      });
    });

    it('should return the choice table of every nature in both classes', () => {
      expect(catalog.choice).toEqual({
        'repo-fact': { common: 'local', critical: 'jury' },
        'external-fact': { common: 'web', critical: 'jury' },
        choice: { common: 'jury', critical: 'jury' },
      });
    });

    it('should return the cost order from the most to the least expensive', () => {
      expect(catalog.order).toEqual(['jury', 'web', 'local']);
    });

    it('should return the literal section up to the next heading', () => {
      expect(catalog.section).toMatch(/^## Catálogo de ações\n/);
      expect(catalog.section).not.toContain('## O que o critic registra');
    });

    it('should return the same section when no heading follows it', () => {
      const lastSection = doc.slice(0, doc.indexOf('## O que o critic registra'));

      expect(parseCatalog(lastSection).section).toBe(catalog.section);
    });

    it.each(HEADERS)(
      'should return the same catalog when the separator row has a trailing space: %s',
      (header) => {
        const spaced = editTable(header, (lines, at) => {
          lines[at + 1] = `${lines[at + 1]} `;
        });

        expect(parseCatalog(spaced)).toEqual({ ...catalog, section: expect.any(String) });
      },
    );
  });

  describe('when the catalog is broken', () => {
    it.each(HEADERS)(
      'should throw naming the expected header when the table is missing or changed: %s',
      (header) => {
        const broken = doc.replace(header, '| Changed |');

        expect(() => parseCatalog(broken)).toThrow(header);
      },
    );

    it('should throw naming the heading when the section is missing', () => {
      const broken = doc.replace('## Catálogo de ações', '## Outra seção');

      expect(() => parseCatalog(broken)).toThrow('## Catálogo de ações');
    });

    it('should throw naming the cost order when its bullet is missing', () => {
      const broken = doc.replace('Ordem de custo', 'Outra ordem');

      expect(() => parseCatalog(broken)).toThrow('Ordem de custo');
    });

    it.each(HEADERS)(
      'should throw when a blank line sits between the header and the separator: %s',
      (header) => {
        const broken = editTable(header, (lines, at) => lines.splice(at + 1, 0, ''));

        expect(() => parseCatalog(broken)).toThrow(
          `catalog table has no separator row right after header "${header}"`,
        );
      },
    );

    it.each(HEADERS)('should throw when the separator row is missing: %s', (header) => {
      const broken = editTable(header, (lines, at) => lines.splice(at + 1, 1));

      expect(() => parseCatalog(broken)).toThrow(
        `catalog table has no separator row right after header "${header}"`,
      );
    });

    it.each(HEADERS)('should throw when the table has no rows: %s', (header) => {
      const broken = editTable(header, (lines, at) =>
        lines.splice(
          at + 2,
          lines.slice(at + 2).findIndex((line) => !line.startsWith('|')),
        ),
      );

      expect(() => parseCatalog(broken)).toThrow(
        `catalog table has no rows under header "${header}"`,
      );
    });

    it.each(HEADERS)('should throw naming the line when a row is indented: %s', (header) => {
      const broken = editTable(header, (lines, at) => {
        lines[at + 2] = ` ${lines[at + 2]}`;
      });

      expect(() => parseCatalog(broken)).toThrow(
        `catalog table has an indented row under header "${header}": " |`,
      );
    });

    it.each(HEADERS)('should throw when a row has more cells than the header: %s', (header) => {
      const broken = editTable(header, (lines, at) => {
        lines[at + 2] = `${lines[at + 2]} extra |`;
      });

      expect(() => parseCatalog(broken)).toThrow(
        `catalog table has a malformed row under header "${header}"`,
      );
    });

    it.each([
      [ACTIONS_HEADER, 'local'],
      [AVAILABILITY_HEADER, 'local'],
      [CHOICE_HEADER, 'repo-fact'],
    ])('should throw naming the action when a row repeats under %s', (header, name) => {
      const broken = editTable(header, (lines, at) => lines.splice(at + 3, 0, lines[at + 2] ?? ''));

      expect(() => parseCatalog(broken)).toThrow(
        `catalog table has a duplicate row "${name}" under header "${header}"`,
      );
    });

    it.each([
      ['a hyphen', '-'],
      ['an empty cell', ''],
    ])(
      'should throw naming the action and column when an availability cell is %s',
      (_label, cell) => {
        const broken = doc.replace(
          '| `local` | explore | explore | próprio |',
          `| \`local\` | ${cell} | explore | próprio |`,
        );

        expect(() => parseCatalog(broken)).toThrow(
          `catalog availability cell for action "local" in column "claude-herdr" must be "—" or an agent/skill name, got "${cell}"`,
        );
      },
    );

    it.each([
      ['has no backticks', 'jury, web, local.', 'jury, web, local'],
      ['is incomplete', '`jury`, `web`.', '`jury`, `web`'],
      ['cites an action outside the table', '`jury`, `web`, `robot`.', '`jury`, `web`, `robot`'],
      ['repeats an action', '`jury`, `jury`, `local`.', '`jury`, `jury`, `local`'],
    ])('should throw listing the actions when the cost order %s', (_label, order, got) => {
      const broken = doc.replace(ORDER, order);

      expect(() => parseCatalog(broken)).toThrow(
        `catalog cost order must list each availability action exactly once in backticks (local, web, jury), got "${got}"`,
      );
    });
  });
});

describe('renderActions', () => {
  const catalog = parseCatalog(doc);

  it.each([
    ['claude-herdr', 'jury, web, local'],
    ['claude-runner', 'jury, web, local'],
    ['agy', 'web, local'],
  ] as const)(
    'should return the literal section followed by the actions available to %s',
    (transport, available) => {
      expect(renderActions(catalog, transport)).toBe(
        `${catalog.section}\n\nações disponíveis para você (${transport}): ${available}`,
      );
    },
  );

  it.each([
    'Consultar o hexlog ou os docs diretamente não é a ação `local`',
    '`actionUsed` registra a ação de maior custo que contribuiu',
    'Sem `actionUsed` fixado a ação indisponível não degrada',
    'Comum: só quando a evidência local (hexlog, docs, ADRs) não decide. Crítica: exigida.',
    '`Unavailable: <ações>` só vale como linha de cabeçalho da mensagem',
  ])('should carry the contract sentence: %s', (sentence) => {
    expect(renderActions(catalog, 'claude-herdr')).toContain(sentence);
    expect(doc).toContain(sentence);
  });
});

describe('cadeira-do-dono.md action catalog', () => {
  it('should stay coherent with the actionUsed enum of the premise type', () => {
    expect(coherenceProblems(parseCatalog(doc), actionUsedEnum)).toEqual([]);
  });

  describe('when the catalog drifts', () => {
    it('should fail when the actionUsed enum differs from the catalog actions', () => {
      const catalog = parseCatalog(doc);

      expect(coherenceProblems(catalog, ['local', 'web'])).toEqual([
        'actionUsed enum differs from the catalog actions',
      ]);
    });

    it('should fail when the actions table lacks an action the availability table lists', () => {
      const catalog = parseCatalog(
        doc.replace(
          '| `web` | A pergunta de fato externo | Fatos de fonte externa, com a fonte | Fato externo, ou fallback de `jury` indisponível. |\n',
          '',
        ),
      );

      expect(coherenceProblems(catalog, actionUsedEnum)).toEqual([
        'actionUsed enum differs from the catalog actions',
        'cost order is not a permutation of the actions',
        'choice table cites an action outside the catalog',
      ]);
    });

    it('should fail when a choice cell cites an action outside the catalog', () => {
      const catalog = parseCatalog(
        doc.replace('| `repo-fact` | local | jury |', '| `repo-fact` | robot | jury |'),
      );

      expect(coherenceProblems(catalog, actionUsedEnum)).toEqual([
        'choice table cites an action outside the catalog',
      ]);
    });
  });
});

describe('critic-tools.ts and critic-catalog.ts', () => {
  it('should keep critic-tools.ts and critic-catalog.ts free of fs and src imports', () => {
    const specifiers = ['scripts/flow/critic-tools.ts', 'scripts/flow/critic-catalog.ts']
      .flatMap((file) => [
        ...read(file).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm),
      ])
      .map(([, specifier = '']) => specifier);

    expect(
      specifiers.filter((specifier) => /^(node:)?fs(\/|$)|(^|\/)src\//.test(specifier)),
    ).toEqual([]);
  });
});
