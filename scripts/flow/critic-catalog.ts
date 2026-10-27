// Leitura do catálogo de ações do critic: a seção "Catálogo de ações" de `cadeira-do-dono.md` é a
// fonte, e este módulo só a lê e a renderiza. Puro: recebe o texto do doc e devolve dados, sem I/O
// (quem lê o arquivo é `critic-run.ts`). Só builtins do Node, como `critic-tools.ts`.

const SECTION_HEADING = '## Catálogo de ações';
const COLUMNS = ['claude-herdr', 'claude-runner', 'agy'] as const;
export type Column = (typeof COLUMNS)[number];

const ACTIONS_HEADER = '| Ação | Entrada | Saída | Quando é permitida |';
const AVAILABILITY_HEADER = `| Ação | ${COLUMNS.join(' | ')} |`;
const CHOICE_HEADER = '| Natureza | comum | crítica |';
const ORDER_LINE = /^- Ordem de custo, da mais cara à mais barata: (.+)\.$/m;

/** Célula da tabela por transporte sem canal para a ação. */
const UNAVAILABLE = '—';

const unquote = (cell: string): string => cell.replace(/^`(.*)`$/, '$1');

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

/** Linhas de dados da tabela de cabeçalho exato `header`; lança se ela falta ou se uma linha destoa. */
function rowsUnder(lines: string[], header: string): string[][] {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1)
    throw new Error(`catalog table missing or changed: expected header "${header}"`);
  const width = cellsOf(header).length;
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(cellsOf(line));
  }
  if (rows.some((row) => row.length !== width)) {
    throw new Error(`catalog table has a malformed row under header "${header}"`);
  }
  return rows;
}

function sectionLines(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === SECTION_HEADING);
  if (start === -1)
    throw new Error(`catalog section missing: expected heading "${SECTION_HEADING}"`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, next === -1 ? undefined : next);
}

export function parseCatalog(text: string) {
  const lines = sectionLines(text);
  const section = lines.join('\n').trimEnd();

  const actions = Object.fromEntries(
    rowsUnder(lines, ACTIONS_HEADER).map(([name = '', input = '', output = '', allowed = '']) => [
      unquote(name),
      { input, output, allowed },
    ]),
  );
  const availability: Record<string, Record<string, string>> = Object.fromEntries(
    rowsUnder(lines, AVAILABILITY_HEADER).map(([name = '', ...values]) => [
      unquote(name),
      Object.fromEntries(COLUMNS.map((column, index) => [column, unquote(values[index] ?? '')])),
    ]),
  );
  const choice = Object.fromEntries(
    rowsUnder(lines, CHOICE_HEADER).map(([nature = '', common = '', critical = '']) => [
      unquote(nature),
      { common: unquote(common), critical: unquote(critical) },
    ]),
  );

  const orderText = ORDER_LINE.exec(section)?.[1];
  if (orderText === undefined) {
    throw new Error(
      'catalog cost order missing or changed: expected "- Ordem de custo, da mais cara à mais barata: ..."',
    );
  }
  const order = [...orderText.matchAll(/`([^`]+)`/g)].map(([, action = '']) => action);

  return { actions, availability, order, choice, section };
}

/** A seção literal mais a linha das ações que a coluna (transporte) alcança, da mais cara à mais barata. */
export function renderActions(catalog: ReturnType<typeof parseCatalog>, column: Column): string {
  const available = catalog.order.filter(
    (action) => (catalog.availability[action]?.[column] ?? UNAVAILABLE) !== UNAVAILABLE,
  );
  return `${catalog.section}\n\nações disponíveis para você (${column}): ${available.join(', ')}`;
}
