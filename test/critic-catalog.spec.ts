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
const ORDER = '`jury`, `web`, `local`.';

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
  });

  describe('when the catalog is broken', () => {
    it.each([ACTIONS_HEADER, AVAILABILITY_HEADER, CHOICE_HEADER])(
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
  });
});

describe('renderActions', () => {
  const catalog = parseCatalog(doc);

  it('should return the literal section followed by the actions available to the transport', () => {
    expect(renderActions(catalog, 'claude-herdr')).toBe(
      `${catalog.section}\n\nações disponíveis para você (claude-herdr): jury, web, local`,
    );
  });

  it('should leave jury out of the available actions for agy', () => {
    const rendered = renderActions(catalog, 'agy');

    expect(rendered).toMatch(/ações disponíveis para você \(agy\): web, local$/);
  });

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

    it.each([
      ['an action outside the catalog', '`jury`, `web`, `robot`.'],
      ['a missing action', '`jury`, `web`.'],
    ])('should fail when the cost order cites %s', (_label, order) => {
      const catalog = parseCatalog(doc.replace(ORDER, order));

      expect(coherenceProblems(catalog, actionUsedEnum)).toEqual([
        'cost order is not a permutation of the actions',
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
