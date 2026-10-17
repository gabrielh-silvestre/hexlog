export const meta = {
  name: 'friction-mining-run',
  description: 'Mine Claude Code transcripts for hexlog friction: extract signals, analyze by lane, consolidate, write report and drafts, verify',
  whenToUse: 'Launched by the friction-mining skill with its args; not meant to run standalone',
  phases: [
    { title: 'Extract', detail: 'mine.py over the window' },
    { title: 'Analyze', detail: 'fixed lanes per tool + discovery lanes per uncovered bucket + harness lane' },
    { title: 'Consolidate', detail: 'merge overlapping findings, match prior art' },
    { title: 'Write', detail: 'report + issue/comment drafts' },
    { title: 'Verify', detail: 'verifier + fixer, up to 2 rounds' },
  ],
}

// args: { projectDir, projectSlug, from, to, repoRoot, skillDir, out, reportPath, draftsDir, priorArt }
const A = typeof args === 'string' ? JSON.parse(args) : args
const MISSING = ['projectDir', 'projectSlug', 'from', 'to', 'repoRoot', 'skillDir', 'out', 'reportPath', 'draftsDir']
  .filter(k => !A || !A[k])
if (MISSING.length) return { error: `launch via /friction-mining; missing args: ${MISSING.join(', ')}` }
// Regra global do usuário: subagentes em sonnet/haiku, salvo liberação explícita.
const MODEL = 'sonnet'
const TOOL_ORDER = ['register', 'evaluate_gate', 'query', 'list']
const CONF_ORDER = { high: 0, medium: 1, low: 2 }
const MAX_PARALLEL = 12 // regra global do usuário: no máximo 12 subagentes por lote

const CONTEXT = `Contexto da rodada:
- projeto-fonte: ${A.projectDir} (slug ${A.projectSlug}), janela ${A.from} a ${A.to}
- saída do script: ${A.out} (calls.jsonl, buckets *.jsonl, stats.json)
- repo do hexlog (checkout principal): ${A.repoRoot}
- prior art (não re-reportar; evidência nova vira reinforces): ${A.priorArt}
Leia antes de tudo: ${A.skillDir}/references/briefing.md (troque {out}, {projectDir} e {priorArt} pelos valores acima).`

const FINDING = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    tool: { type: 'string', description: 'nome curto sem prefixo (register, query, list, …); uma só tool' },
    signal: { type: 'string', description: 'a, b, c, d ou e (combinações como c+d)' },
    harness: { type: 'boolean' },
    reinforces: { type: 'string', description: 'item de prior art reforçado (ex.: #14, P7) ou string vazia' },
    occurrences: { type: 'integer' },
    parent_sessions: { type: 'array', items: { type: 'string' } },
    metrics: { type: 'string', description: 'números com o impacto ao lado' },
    quote: { type: 'string' },
    quote_session: { type: 'string' },
    quote_ts: { type: 'string' },
    cause: { type: 'string', description: 'arquivo:linha + 1 frase' },
    cause_located: { type: 'boolean' },
    improvement: { type: 'string' },
  },
  required: ['title', 'tool', 'signal', 'harness', 'reinforces', 'occurrences', 'parent_sessions', 'metrics',
    'quote', 'quote_session', 'quote_ts', 'cause', 'cause_located', 'improvement'],
}
const LANE_OUT = {
  type: 'object',
  properties: { findings: { type: 'array', items: FINDING }, discarded: { type: 'string' } },
  required: ['findings', 'discarded'],
}

const FIXED = [
  { key: 'register-gate', tools: ['register', 'evaluate_gate'], match: /^(a_error|d_cost)_(register|evaluate_gate)$/,
    focus: 'erros e retries de register/evaluate_gate e a causa em src/; rajadas de evaluate_gate sobre a mesma unidade (chamadas, milestones gravados no log); tamanho da resposta de register; hesitação sobre formato de id/tipo no campo before.' },
  { key: 'query-orientation', tools: ['query'], match: /^c_orient_query$/,
    focus: 'agrupar as leituras repetidas de query por padrão (paginação completa, enumeração de targets irmãos, text longo, polling, releitura) e dizer se o servidor evitaria (filtro, cursor, fields, changesSince) ou se é harness; amostrar ~20 chamadas de query fora do bucket atrás de padrão novo.' },
  { key: 'query-cost', tools: ['query'], match: /^(d_cost|a_error)_query$/,
    focus: 'composição do payload das respostas >10k de query (data vs relações e metadados por registro), páginas que param no teto de chars, uso de fields, registros citados depois pelo agente; recontar redundância além da heurística do script.' },
  { key: 'list-misc', tools: ['list', 'verify_chain', 'create_process', 'attach', 'read_attachment', 'describe_type', 'define_type', 'define_relation', 'define_gate'],
    match: /_(list|verify_chain|create_process|attach|read_attachment|describe_type|define_type|define_relation|define_gate)$/,
    focus: 'para que o agente chama cada tool, se o resultado é usado, e evidência dos itens de prior art nos args de todas as tools da janela.' },
  { key: 'user', bucketOnly: 'e_user', match: /^e_user$/,
    focus: 'classificar cada mensagem (correção do agente sobre hexlog, reclamação do servidor, pedido neutro, ruído); para correções e reclamações, o que o agente fez antes, a causa (servidor ou harness) e o que evitaria.' },
  { key: 'harness', always: true, match: /^$/,
    focus: 'atribuição das chamadas por origem (campo origin de calls.jsonl; separar skill do turno, continuação de skill anterior, subagente com instrução no prompt, sem gatilho), custo por execução das skills do projeto-fonte que mais chamam o hexlog e as instruções arquivo:linha que geram o volume; para cada uma, se o ajuste cabe no harness ou pede mudança no hexlog. Inclua a tabela de atribuição em discarded se não couber em achado.' },
]

function confidence(f) {
  const n = new Set(f.parent_sessions).size
  if (n >= 3 && f.cause_located) return 'high'
  if (n >= 2) return 'medium'
  return 'low'
}
function toolRank(t) {
  const i = TOOL_ORDER.indexOf(t)
  return i === -1 ? TOOL_ORDER.length : i
}

// --- Extract
phase('Extract')
const ext = await agent(
  `Rode exatamente: python3 ${A.skillDir}/scripts/mine.py --project-dir ${A.projectDir} --from ${A.from} --to ${A.to} --out ${A.out}
Devolva o JSON que o script imprime, sem alterar, no campo stats_json. Se o script falhar, devolva o erro em stats_json começando com "ERROR:".`,
  { label: 'mine.py', model: MODEL, effort: 'low', schema: { type: 'object', properties: { stats_json: { type: 'string' } }, required: ['stats_json'] } })
if (!ext || ext.stats_json.startsWith('ERROR:')) return { error: ext ? ext.stats_json : 'extract agent died' }
let stats
try { stats = JSON.parse(ext.stats_json) } catch (e) { return { error: 'ERROR: stats_json not JSON: ' + ext.stats_json.slice(0, 300) } }
if (!Object.keys(stats).some(k => k.startsWith('calls:'))) return { error: 'no hexlog calls in window', stats }
const calls = t => stats[`calls:${t}`] || 0
const buckets = Object.keys(stats).filter(k => k.startsWith('bucket:') && stats[k] > 0).map(k => k.slice(7))

// --- Analyze: fixas ativas + descoberta para bucket sem dono + harness sempre
const active = FIXED.filter(l => l.always
  || (l.tools && l.tools.some(t => calls(t) > 0))
  || (l.bucketOnly && buckets.includes(l.bucketOnly)))
const skipped = FIXED.filter(l => !active.includes(l)).map(l => l.key)
const orphan = buckets.filter(b => !active.some(l => l.match.test(b)))
const lanes = [
  ...active,
  ...orphan.map(b => ({ key: `discover-${b}`, focus: `bucket ${b}.jsonl, que nenhuma lane fixa cobre: descubra o padrão, meça, localize a causa. É uma lane de descoberta; vale achado novo fora dos padrões conhecidos.` })),
]
if (skipped.length) log(`lanes puladas (tool sem chamada na janela): ${skipped.join(', ')}`)
if (orphan.length) log(`lanes de descoberta: ${orphan.join(', ')}`)

phase('Analyze')
const laneResults = []
for (let i = 0; i < lanes.length; i += MAX_PARALLEL) {
  laneResults.push(...await parallel(lanes.slice(i, i + MAX_PARALLEL).map(l => () => agent(
  `${CONTEXT}\n\nSua lane: ${l.key}. Escopo: ${l.focus}\nBuckets relevantes: ${buckets.filter(b => l.match ? l.match.test(b) : b === l.key.slice(9)).join(', ') || '(use calls.jsonl)'}.`,
  { label: `lane:${l.key}`, phase: 'Analyze', model: MODEL, schema: LANE_OUT }).then(r => r && { lane: l.key, ...r }))))
}
const done = laneResults.filter(Boolean)
const lost = lanes.map(l => l.key).filter(k => !done.some(r => r.lane === k))
if (lost.length) log(`lanes sem resultado: ${lost.join(', ')}`)

// --- Consolidate: barreira legítima, a fusão precisa de todos os achados
phase('Consolidate')
const merged = await agent(
  `${CONTEXT}\n\nAchados das lanes (JSON):\n${JSON.stringify(done)}\n\nConsolide: funda achados que descrevem o mesmo mecanismo (una parent_sessions, não some ocorrências duplicadas, mantenha a citação mais forte e as duas pontas da causa quando houver servidor e harness). Não invente achado. Preserve harness e reinforces; se um achado bate com item do prior art, preencha reinforces. Devolva a lista final e, em discarded, a união dos descartados relevantes.`,
  { label: 'consolidate', model: MODEL, schema: LANE_OUT })
if (!merged) return { error: 'consolidate agent died', lanes: done }

const withConf = merged.findings.map(f => ({ ...f, tool: f.tool.replace(/^mcp__hexlog__/, ''), confidence: confidence(f) }))
const byOrder = (a, b) => toolRank(a.tool) - toolRank(b.tool) || a.tool.localeCompare(b.tool) || CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence]
const hex = withConf.filter(f => !f.harness).sort(byOrder)
  .map((f, i) => ({ ...f, id: `H-${String(i + 1).padStart(2, '0')}`, action: f.reinforces.startsWith('#') ? `comment ${f.reinforces}` : (f.reinforces ? 'reinforce-only' : 'issue') }))
const wrk = withConf.filter(f => f.harness).sort((a, b) => CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence])
  .map((f, i) => ({ ...f, id: `W-${String(i + 1).padStart(2, '0')}`, action: 'none' }))
const harnessRaw = (done.find(r => r.lane === 'harness') || {}).discarded || ''
const final = { stats, lanes: lanes.map(l => l.key).filter(k => !lost.includes(k)), lost, skipped, hexlog: hex, harness: wrk, harnessRaw, discarded: merged.discarded }

// --- Write
phase('Write')
const written = await agent(
  `${CONTEXT}\n\nEscreva o relatório em ${A.reportPath} e os rascunhos em ${A.draftsDir}/ seguindo ${A.skillDir}/references/output-format.md. Use exatamente os ids, a confiança e a ordem abaixo; não recalcule. O relatório fica só local: os rascunhos não linkam o relatório e trazem a evidência no próprio corpo. Rascunho por action: action=issue → issue-H-xx.md; action='comment #N' → comment-N.md (achados que reforçam a mesma #N vão no mesmo arquivo, um parágrafo por H-xx); action=reinforce-only → sem rascunho, só na seção Prior art; achados W-xx → sem rascunho. Use harnessRaw para a tabela de atribuição e o custo por skill da seção Harness. Declare no Método as lanes de lost e o sinal que ficou sem cobertura. Escreva só nesses dois destinos.\n\nDados:\n${JSON.stringify(final)}`,
  { label: 'write', model: MODEL, schema: { type: 'object', properties: { report: { type: 'string' }, drafts: { type: 'array', items: { type: 'string' } } }, required: ['report', 'drafts'] } })
if (!written) return { error: 'write agent died', final }

// --- Verify: até 2 voltas de verifier + fixer
phase('Verify')
const VERDICT = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, problems: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, fix: { type: 'string' } }, required: ['problem', 'fix'] } } },
  required: ['pass', 'problems'],
}
let verdict = null
for (let round = 1; round <= 3; round++) { // até 2 correções + verificação final
  verdict = await agent(
    `${CONTEXT}\n\nVerifique (read-only) o relatório ${A.reportPath} e os rascunhos em ${A.draftsDir}/ contra ${A.skillDir}/references/output-format.md e contra estes dados finais:\n${JSON.stringify(final)}\nCheque: formato e ordem; números e sessões batem com os dados; 6 citações amostradas existem nos transcripts (grep -rF em ${A.projectDir} com um trecho de ~40 chars sem aspas, barra invertida nem quebra de linha, porque o transcript guarda JSON escapado); 8 âncoras arquivo:linha de src/ dizem o que o texto afirma; links internos resolvem pelo slug do GitHub; rascunhos seguem o estilo (sem rótulos formulaicos). Os rascunhos não linkam o relatório, que fica só local. Para cada problema, dê a correção exata (texto antigo → novo).`,
    { label: `verify:${round}`, phase: 'Verify', model: MODEL, schema: VERDICT })
  if (!verdict || verdict.pass || !verdict.problems.length || round === 3) break
  await agent(
    `Aplique exatamente estas correções em ${A.reportPath} e nos rascunhos de ${A.draftsDir}/, sem mexer no resto:\n${JSON.stringify(verdict.problems)}`,
    { label: `fix:${round}`, phase: 'Verify', model: MODEL })
}

return {
  report: written.report,
  drafts: written.drafts,
  counts: {
    calls: Object.keys(stats).filter(k => k.startsWith('calls:')).reduce((s, k) => s + stats[k], 0),
    hexlog: hex.length,
    byConfidence: ['high', 'medium', 'low'].map(c => `${c}:${hex.filter(f => f.confidence === c).length}`).join(' '),
    issues: hex.filter(f => f.action === 'issue').length,
    comments: hex.filter(f => f.action.startsWith('comment')).length,
    reinforceOnly: hex.filter(f => f.action === 'reinforce-only').length,
    harness: wrk.length,
  },
  lanes: final.lanes,
  skippedLanes: skipped,
  lostLanes: lost,
  verifyRan: !!verdict,
  residualProblems: !verdict ? [{ problem: 'verifier died', fix: 'rerun verify' }] : (verdict.pass ? [] : verdict.problems),
}
