// POC: gera um HTML estático (retrato, não reativo) do grafo de decisões de um processo, lido pelo
// `composeReader`. Alvos de relação de outro processo (diretriz, premissa atemporal) entram como nós
// com o `data` completo. Uso: node scripts/decision-graph.ts <project>/<process> > graph.html
import { isNil, uniq } from 'es-toolkit';
import { formatCliError, openReadOnly, parseCliArgs } from './cli-error.ts';
import { Name } from '../src/domain/ids.ts';
import type { QueryRecord } from '../src/queries/query-service.ts';

const USAGE = 'usage: node scripts/decision-graph.ts <project>/<process>';
// ordem importa: o cytoscape-dagre se registra sozinho se achar `cytoscape` e `dagre` globais
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js',
  'https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js',
];

type GraphNode = {
  id: string;
  type: string;
  target: string;
  current: boolean;
  data: unknown;
  external?: true;
};
type GraphEdge = {
  from: string;
  to: string;
  kind: string;
  as?: string;
  current: boolean;
};

const isCurrent = (record: QueryRecord) =>
  !record.in.some((relation) => relation.kind === 'supersedes' || relation.kind === 'revokes');

const toNode = (record: QueryRecord, external?: true): GraphNode => ({
  id: record.id,
  type: record.type,
  target: record.target,
  current: isCurrent(record),
  data: record.data,
  ...(external && { external }),
});

/** O `data` do log é hostil: nada de `<` cru dentro do `<script>` embutido. */
const embed = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// O cliente monta o painel só com textContent, nunca innerHTML.
const CLIENT = `
const graph = JSON.parse(document.getElementById('graph-data').textContent);
const COLORS = { decision: '#3b82f6', premise: '#22c55e', gap: '#f59e0b', finding: '#ef4444',
  directive: '#8b5cf6', evidence: '#14b8a6', verification: '#64748b', opening: '#94a3b8' };
// fundo opaco (versão escura de cada cor): aresta que cruza um nó passa por baixo, sem aparecer no texto
const FILLS = { decision: '#1e3a5f', premise: '#14391f', gap: '#4a3410', finding: '#4a1d1d',
  directive: '#2e1f5a', evidence: '#10403d', verification: '#273449', opening: '#273449' };
const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const label = (node) => {
  const d = node.data ?? {};
  const raw = d.choice ?? d.statement ?? d.question ?? d.rule ?? d.summary ?? d.request ??
    d.result ?? d.path ?? node.target;
  const prefix = node.type === 'finding' ? '[' + d.severity + '] ' + (d.description ?? '') : text(raw);
  return prefix.length > 90 ? prefix.slice(0, 87) + '...' : prefix;
};
const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: [
    ...graph.nodes.map((n) => ({ data: { id: n.id, label: label(n), type: n.type,
      current: n.current, external: Boolean(n.external) } })),
    ...graph.edges.map((e, i) => ({ data: { id: 'e' + i, source: e.from, target: e.to,
      label: e.as ?? e.kind, kind: e.kind } })),
  ],
  style: [
    // texto dentro da caixa (largura fixa, quebra de linha): nenhum rótulo sobra para fora do nó
    { selector: 'node', style: { shape: 'round-rectangle', width: 200, height: 64,
      label: 'data(label)', 'font-size': 10, 'text-wrap': 'wrap', 'text-max-width': 186,
      'text-valign': 'center', 'text-halign': 'center', color: '#e2e8f0', 'border-width': 1.5,
      'border-color': (n) => COLORS[n.data('type')] ?? '#cbd5e1', 'z-index-compare': 'manual',
      'z-index': 10, 'background-color': (n) => FILLS[n.data('type')] ?? '#1e293b',
      'background-opacity': 1 } },
    { selector: 'node[?external]', style: { 'border-width': 2, 'border-style': 'dashed' } },
    { selector: 'node[!current]', style: { opacity: 0.4 } },
    // rótulo da aresta só ao passar o mouse ou no rastro; arestas ficam sob os nós
    { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle',
      width: 1.2, 'line-color': '#475569', 'target-arrow-color': '#475569', 'z-index-compare': 'manual', 'z-index': 1,
      'font-size': 9, color: '#e2e8f0', 'text-background-color': '#0b1120',
      'text-background-opacity': 1, 'text-background-padding': 2 } },
    { selector: 'edge.hover, edge.trace', style: { label: 'data(label)', 'z-index': 5 } },
    { selector: 'edge[kind = "supersedes"], edge[kind = "revokes"]',
      style: { 'line-style': 'dashed' } },
    { selector: '.dim', style: { opacity: 0.12 } },
    { selector: '.trace', style: { 'line-color': '#f97316', 'target-arrow-color': '#f97316',
      'border-width': 3, 'border-color': '#f97316', opacity: 1 } },
  ],
  layout: { name: 'dagre', rankDir: 'LR', nodeSep: 28, rankSep: 140, edgeSep: 12 },
});
cy.on('mouseover', 'edge', (event) => event.target.addClass('hover'));
cy.on('mouseout', 'edge', (event) => event.target.removeClass('hover'));
const panel = document.getElementById('detail-panel');
const add = (parent, tag, content) => {
  const el = document.createElement(tag);
  el.textContent = content;
  parent.append(el);
  return el;
};
function show(node) {
  panel.replaceChildren();
  add(panel, 'h2', node.type + (node.external ? ' (outro processo)' : '') + (node.current ? '' : ' (superado)'));
  add(panel, 'code', node.id);
  const dl = add(panel, 'dl', '');
  for (const [key, value] of Object.entries(node.data ?? {})) {
    add(dl, 'dt', key);
    if (key === 'alternatives' && Array.isArray(value)) {
      const ul = add(dl, 'dd', '');
      for (const alt of value) add(ul, 'p', alt.option + ' — ' + alt.reason);
    } else add(dl, 'dd', text(value));
  }
}
cy.on('tap', 'node', (event) => {
  const node = graph.nodes.find((n) => n.id === event.target.id());
  show(node);
  cy.elements().removeClass('trace').addClass('dim');
  // o porquê: tudo que o nó alcança pelas arestas de saída, mais os vizinhos diretos que o apontam
  event.target.union(event.target.successors()).union(event.target.incomers())
    .removeClass('dim').addClass('trace');
});
cy.on('tap', (event) => {
  if (event.target === cy) cy.elements().removeClass('dim trace');
});
`;

function render(processId: string, graph: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(processId)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;display:flex;height:100vh;font:14px system-ui,sans-serif;background:#0b1120;color:#e2e8f0}
#cy{flex:1}#detail-panel{width:380px;overflow:auto;padding:12px;background:#111827;border-left:1px solid #334155}
h2{margin-top:0}code{color:#94a3b8;word-break:break-all}
dt{font-weight:bold;margin-top:8px;color:#93c5fd}dd{margin:0;white-space:pre-wrap}
</style></head><body>
<div id="cy"></div>
<aside id="detail-panel"><p>Clique num nó para ver o detalhe e o rastro.</p></aside>
<script type="application/json" id="graph-data">${embed({ process: processId, ...graph })}</script>
${LIBS.map((src) => `<script src="${src}"></script>`).join('\n')}
<script>${CLIENT}</script>
</body></html>
`;
}

function main(argv: string[]): number {
  const args = parseCliArgs(argv, {});
  const [target, ...extra] = args?.positionals ?? [];
  const [projectArg, processArg, ...rest] = target?.split('/') ?? [];
  const project = Name.safeParse(projectArg);
  const processName = Name.safeParse(processArg);
  if (
    isNil(args) ||
    extra.length > 0 ||
    !project.success ||
    !processName.success ||
    rest.length > 0
  ) {
    console.error(`decision-graph failed: ${USAGE}`);
    return 1;
  }

  try {
    const { query } = openReadOnly();
    const load = (name: Name) =>
      query.queryRecords({
        project: project.data,
        process: name,
        includeNonCurrent: true,
        limit: Number.MAX_SAFE_INTEGER,
      }).records;

    const records = load(processName.data);
    const nodes = new Map(records.map((record) => [record.id, toNode(record)]));
    const edges: GraphEdge[] = records.flatMap((record) =>
      record.out.map(({ to, kind, as, current }) => ({
        from: record.id,
        to,
        kind,
        ...(as && { as }),
        current: current ?? true,
      })),
    );

    // alvos de outro processo (diretriz, premissa atemporal): um `query` por processo referenciado
    const foreign = uniq(edges.map((edge) => edge.to).filter((id) => !nodes.has(id)));
    for (const name of uniq(foreign.map((id) => id.split(':')[0] ?? ''))) {
      const parsed = Name.safeParse(name);
      if (!parsed.success) continue;
      for (const record of load(parsed.data)) {
        if (foreign.includes(record.id)) nodes.set(record.id, toNode(record, true));
      }
    }
    // alvo que nenhum processo devolveu: nó vazio, para a aresta não ficar solta
    for (const id of foreign) {
      if (!nodes.has(id)) {
        nodes.set(id, { id, type: 'unknown', target: id, current: true, data: {}, external: true });
      }
    }

    process.stdout.write(
      render(`${project.data}/${processName.data}`, { nodes: [...nodes.values()], edges }),
    );
    return 0;
  } catch (error) {
    const { text, exitCode } = formatCliError('decision-graph', error);
    console.error(text);
    return exitCode;
  }
}

process.exitCode = main(process.argv.slice(2));
