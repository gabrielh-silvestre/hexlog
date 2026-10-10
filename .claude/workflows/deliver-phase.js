export const meta = {
  name: 'deliver-phase',
  description: 'Entrega autônoma de uma fase da v1 do hexlog: execução, painel, decisões e fechamento, com decisor, pesquisa, júri e registro no hexlog',
  whenToUse: 'Só pela skill deliver-phase com --autonomo, na sessão TeamLead da fase, com os args da fase',
  phases: [
    { title: 'Execução', detail: 'ralph em estágios: plano, executores, architect, critic, commit e PR' },
    { title: 'Decisões', detail: 'decisor, pesquisa, júri e registro orchestrator-decision' },
    { title: 'Painel', detail: 'base, especialistas, síntese, investigação e veredito por regra' },
    { title: 'Ajuste', detail: 'aplicação das decisões, suíte verde e commit de ajuste' },
    { title: 'Fechamento', detail: 'issue de MINIMAL, handoff da próxima fase e registro' },
  ],
}

// Spec: .omc/specs/deliver-v1-autonomo.md. Todo agent() roda em sonnet (Q16);
// o runtime limita a 16 agentes simultâneos (Q12). Prompts em pt-BR; log() e
// erros em inglês, pela regra de idioma do CLAUDE.md do repo.

const A = args || {}
for (const k of ['phase', 'slug', 'branch', 'base', 'target', 'repo', 'worktree', 'startBlock', 'date', 'nextPhase', 'nextSlug', 'planSection']) {
  if (A[k] === undefined || A[k] === null || A[k] === '') throw new Error(`deliver-phase: missing required arg: ${k}`)
}

const MODEL = 'sonnet'
const MAX_RALPH = 4
const MAX_SUITE_FIX = 3
const OWNER = 'gabrielh-silvestre'
const REPO = 'hexlog'
const SUITE = 'npm run typecheck && npm run lint && npm run format:check && npm test'
const PRDIR = (n) => `${A.repo}/.ignore/reviews/prs/PR${n}`
const HANDOFF = `${A.repo}/.omc/handoffs/v1-${A.slug}.md`
const PEND = `${A.repo}/.omc/handoffs/v1-${A.slug}-pendencias.md`
const NEXT_HANDOFF = `${A.repo}/.omc/handoffs/v1-${A.nextSlug}.md`
const POLICY = `${A.repo}/.claude/skills/deliver-v1/references/politica-de-decisao.md`
const DECISION_TYPE_SCHEMA = `${A.repo}/.claude/skills/deliver-v1/references/orchestrator-decision.schema.json`
const PANEL_ROLES = {
  architect: 'oh-my-claudecode:architect',
  critic: 'oh-my-claudecode:critic',
  verifier: 'oh-my-claudecode:verifier',
  'code-simplifier': 'oh-my-claudecode:code-simplifier',
  'qa-tester': 'oh-my-claudecode:qa-tester',
  'test-engineer': 'oh-my-claudecode:test-engineer',
  'security-reviewer': 'oh-my-claudecode:security-reviewer',
  'document-specialist': 'oh-my-claudecode:document-specialist',
}
const ALWAYS_ROLES = ['architect', 'critic', 'verifier', 'code-simplifier']

// Caminho real da worktree: o plano do bloco 1 pode corrigi-lo; todo prompt lê daqui.
let WT = A.worktree

function preamble() {
  return `Contexto: workflow autônomo "deliver-phase" da v1 do hexlog, fase ${A.phase} (branch "${A.branch}", base "${A.base}", target hexlog ${A.target}). Repositório principal: ${A.repo}. Worktree da fase: ${WT}. Data: ${A.date}. Spec: ${A.repo}/.omc/specs/deliver-v1-autonomo.md.
Modo autônomo, autorizado pelo usuário na spec: não há humano nesta execução. Nunca pergunte nem espere confirmação; nesta execução, "sempre perguntar" e "entrevista item a item" do CLAUDE.md global cedem ao decisor do script. Dúvida ou decisão aberta vai no campo próprio da sua saída estruturada.
Regras de todo estágio:
- Rode comandos de código dentro da worktree da fase (cd ${WT}) e edite arquivos pelo caminho absoluto dela. O repositório principal só recebe artefatos de processo (.omc/, .ignore/).
- Código, nomes, mensagens de runtime e títulos de teste em inglês; comentários e .md em pt-BR; documentação cita arquivo#símbolo, nunca número de linha.
- Worktree e branch só por Worktrunk (wt, skill worktrunk), nunca git worktree, git merge ou git branch -d. Branch com "!" (ex.: feat!/v1-cutover) vai sempre entre aspas simples no shell; o zsh expande "!".
- Proibido: node scripts/install.ts, git tag, merge de PR, wt remove, npm run test:budget (orçamento só no CI), test.skip/.only, apagar a worktree da fase.
- Commit: Conventional Commits, só subject com até 80 caracteres, sem corpo, mensagem literal na linha do comando (o hook recusa variável), sem citar Claude ou Anthropic.
- GitHub só pelo MCP github-official (carregue por ToolSearch), owner ${OWNER}, repo ${REPO}. Texto de PR, issue e comentário em pt-BR, curto, sem travessão; se o hook stop-slop recusar, reescreva mais seco e reenvie.
- hexlog, projeto "hexlog": carregue as tools por ToolSearch (ex.: "select:mcp__hexlog__register,mcp__hexlog__attachment") e siga a skill hexlog-flow. Anexo por attachment com text antes do register. verdict exige claim, source, result, evidence, target, origin e trace; deviation exige source e alternatives. Em erro de lock, reenvie; em INVALID_EVENT, corrija o campo apontado.
- Página web: WebFetch é negado; use ctx_fetch_and_index. Leitura dirigida (grep, ctx_search), não arquivos inteiros sem necessidade.`
}

function run(prompt, opts) {
  return agent(`${preamble()}\n\n${prompt}`, { model: MODEL, ...opts })
}

// ---- schemas de saída ----

const S = (props, required) => ({ type: 'object', properties: props, required: required || Object.keys(props) })
const STR = { type: 'string' }
const INT = { type: 'integer' }
const BOOL = { type: 'boolean' }
const STRS = { type: 'array', items: STR }
const SEVERITY = { type: 'string', enum: ['BLOCKING', 'URGENT', 'NORMAL', 'MINIMAL'] }
const ACTION = { type: 'string', enum: ['apply', 'downgrade-minimal', 'discard', 'accept-risk', 'defer', 'doc-only', 'proceed', 'scope-cut'] }
const CONFIDENCE = { type: 'string', enum: ['alta', 'media', 'baixa'] }

const ITEM = S({ id: STR, question: STR, context: STR, options: STRS, recommendation: STR, docOnly: BOOL })
const ITEMS_SCHEMA = S({ items: { type: 'array', items: ITEM }, notes: STR })
const DECISION_PROPS = {
  options: STRS,
  chosen: STR,
  action: ACTION,
  confidence: CONFIDENCE,
  confidenceReason: STR,
  precedents: STRS,
  policyRules: STRS,
  contrariesUser: BOOL,
  contrariedDecision: STR,
  deferredTo: STR,
  changesCode: BOOL,
  justification: STR,
  researchQuestions: { type: 'array', items: S({ question: STR, kind: { type: 'string', enum: ['external', 'repo'] } }) },
}
const DECISION_SCHEMA = S(DECISION_PROPS)
const REDECISION_SCHEMA = S({ ...DECISION_PROPS, researchConclusive: BOOL })
const JURY_FINAL_SCHEMA = S({ ...DECISION_PROPS, juryVerdict: STR })
const RESEARCH_SCHEMA = S({ answer: STR, conclusive: BOOL, sources: STRS })
const JURY_FRAME_SCHEMA = S({ question: STR, options: STRS, rubric: STR, jurors: { type: 'array', items: S({ role: { type: 'string', enum: ['proponent', 'devils-advocate', 'integrator', 'persona'] }, persona: STR, lens: STR }) } })
const JUROR1_SCHEMA = S({ choice: STR, confidence: INT, evidenceGrade: { type: 'string', enum: ['A', 'B', 'C', 'D'] }, reasons: STRS })
const JUROR2_SCHEMA = S({ steelman: STR, wouldChangeMyMind: STR, finalChoice: STR, finalConfidence: INT, flipReason: STR })
const RECORD_SCHEMA = S({ eventIds: STRS, attachmentHash: STR, deviationIds: STRS })
const WRITE_SCHEMA = S({ written: STRS })
const STORIES_SCHEMA = S({ worktree: STR, stories: { type: 'array', items: S({ id: STR, title: STR, files: STRS, instructions: STR, integration: BOOL }) }, doneCriteria: STRS })
const EXEC_SCHEMA = S({ summary: STR, filesChanged: STRS, suiteGreen: BOOL, openQuestions: STRS, deviations: STRS })
const FINDING = S({ severity: SEVERITY, finding: STR, fix: STR })
const REVIEW_SCHEMA = S({ verdict: { type: 'string', enum: ['approve', 'reject'] }, findings: { type: 'array', items: FINDING } })
const APPLY_SCHEMA = S({ suiteGreen: BOOL, summary: STR, failing: STR, deviations: STRS })
const SHIP_SCHEMA = S({ prNumber: INT, headSha: STR, url: STR, commits: STRS })
const PANEL_PREP_SCHEMA = S({ prdir: STR, reportFile: STR, headSha: STR, diffFiles: STRS, judgeLeads: STR, roles: { type: 'array', items: S({ role: STR, reason: STR }) } })
const REPORT_SCHEMA = S({ markdown: STR, findings: { type: 'array', items: S({ id: STR, severity: SEVERITY, location: STR, summary: STR }) } })
const INVEST_SCHEMA = S({ id: STR, conclusion: { type: 'string', enum: ['FIX', 'PRODUCT_DECISION'] }, evidence: STR, fix: STR, question: STR, options: STRS, recommendation: STR })
const VERDICT_SCHEMA = S({ verdict: { type: 'string', enum: ['approve', 'request_changes'] }, reviewUrl: STR, headSha: STR, hexlogVerdictId: STR })
const FIXSHIP_SCHEMA = S({ sha: STR, commentUrl: STR, hexlogVerdictId: STR, gatePassed: BOOL })
const CLOSE_SCHEMA = S({ issueNumber: INT, issueUrl: STR, handoffFile: STR, handoffMilestoneId: STR, wikiPage: STR })

// ---- registro no hexlog (Q6) ----

const ALL_DECISIONS = []
const UNRECORDED = []

const cut = (s, n) => String(s === undefined || s === null || s === '' ? '-' : s).slice(0, n)

// Poda a entrada para o schema fechado de orchestrator-decision: campos fora dele
// e strings vazias em opcionais seriam recusados pelo register.
function toEvent(e) {
  const options = (e.options || []).filter(Boolean).slice(0, 8).map((o) => cut(o, 300))
  const ev = {
    target: A.target,
    gate: e.gate,
    item: cut(`${e.gate}/${e.item}`, 100),
    question: cut(e.question, 700),
    options: options.length ? options : [cut(e.chosen, 300)],
    chosen: cut(e.chosen, 300),
    action: e.action,
    decidedBy: e.decidedBy,
    confidence: e.confidence,
    precedents: (e.precedents || []).filter(Boolean).slice(0, 12).map((p) => cut(p, 300)),
    policyRules: (e.policyRules || []).filter((r) => /^R[0-9]{1,2}$/.test(r)).slice(0, 16),
    researchTriggered: Boolean(e.researchTriggered),
    juryConvened: Boolean(e.juryConvened),
    contrariesUser: Boolean(e.contrariesUser),
    justification: cut(e.justification, 1500),
  }
  if (e.researchTriggered) ev.researchConclusive = Boolean(e.researchConclusive)
  if (e.juryConvened && e.juryVerdict) ev.juryVerdict = cut(e.juryVerdict, 500)
  if (e.contrariesUser && e.contrariedDecision) ev.contrariedDecision = cut(e.contrariedDecision, 300)
  if (e.deferredTo) ev.deferredTo = cut(e.deferredTo, 300)
  return ev
}

async function record(events, trail, phaseTitle, label) {
  const prompt = `Registre no hexlog decisões do fluxo autônomo. Projeto "hexlog", processo "omc-orchestrate", tipo "orchestrator-decision" (schema fechado em ${DECISION_TYPE_SCHEMA}).
1. mcp__hexlog__attachment com text = o dossiê abaixo, em JSON. Guarde o hash. Se o anexo for recusado por tamanho, resuma a pesquisa e o júri e reenvie.
2. mcp__hexlog__register com um evento "orchestrator-decision" por item de "Eventos" (agent "deliver-phase"): use cada objeto como data, sem mudar campo, e acrescente attachment = o hash.
3. Para cada evento com contrariesUser true: register "deviation" no mesmo processo (source "deliver-phase", trigger "plan-deviation", symptom e cause curtos, attempts [], alternatives com as opções descartadas e o porquê, outcome { status "resolved", decidedBy "orchestrator", affected = o item }, attachment = o mesmo hash, relatedEvent = o id do evento do passo 2).
Se for retentativa, consulte antes mcp__hexlog__events do processo pelo item e não registre de novo o que já está lá.
Saída: eventIds (um por evento, na ordem), attachmentHash, deviationIds.

Eventos:
${JSON.stringify(events)}

Dossiê:
${JSON.stringify(trail)}`
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rec = await run(prompt, { label: attempt === 1 ? label : `${label}:retry`, phase: phaseTitle, schema: RECORD_SCHEMA })
    if (rec && rec.eventIds && rec.eventIds.length >= events.length) return rec
    log(`hexlog record failed for ${label} (attempt ${attempt})`)
  }
  UNRECORDED.push(...events)
  return null
}

// ---- decisão: decisor → pesquisa → júri (Q4, Q5, Q11) ----

function itemText(item) {
  return `Item: ${item.id}
Pergunta: ${item.question}
Contexto: ${item.context}
Opções recebidas: ${(item.options || []).join(' | ') || '(nenhuma)'}
Recomendação recebida: ${item.recommendation || '(nenhuma)'}`
}

function decisorPrompt(gate) {
  return `Você é o DECISOR do fluxo autônomo: substitui o usuário no gate "${gate}". Decida como ele decidiria, com justificativa concreta (a dependência real e a consequência, nunca "boa prática" solta), e declare a sua confiança com honestidade.

Consulte as fontes nesta precedência (a decisão explícita mais nova vence a regra inferida):
1. Decisões já tomadas: ${A.repo}/.omc/handoffs/v1-*-pendencias.md (seções "## Decisões") e ${A.repo}/.ignore/reviews/prs/PR*/open-items.md (seções "## Decisões da entrevista item a item").
2. Decisões anteriores deste fluxo: mcp__hexlog__events, projeto "hexlog", processo "omc-orchestrate" (pode estar vazio).
3. Plano ${A.repo}/.omc/plans/ralplan-hexlog-1-0.md: §4.1, a seção que começa por "${A.planSection}", §9, §14 e as decisões D-xx; ADRs em ${A.repo}/docs/adr-*.md.
4. Wiki do OMC: wiki_query com o vocabulário do item.
5. Política de regras inferidas: ${POLICY} (hipóteses R1–R16; leia "Como usar" e "Assinatura dos casos difíceis").

Saída:
- options: as opções recebidas mais as alternativas que você gerar; nos casos difíceis o usuário inventou a saída certa.
- chosen: a opção escolhida, literal. action: apply (corrigir ou implementar agora), downgrade-minimal (vira item da issue de MINIMAL), discard (falso positivo), accept-risk (aceitar e documentar), defer (adiar com registro durável), doc-only (só documentação).
- confidence: alta só quando um precedente explícito ou uma regra de confiança alta cobre o caso sem ambiguidade; senão media ou baixa. confidenceReason: o porquê.
- precedents: citações curtas (ex.: "PR66 open-items N2", "plano §14 D-10", "wiki <slug>"). policyRules: IDs usados.
- contrariesUser: true se a escolha contraria decisão explícita do usuário; contrariedDecision cita qual (senão "").
- deferredTo: onde o item reaparece quando action é defer ou downgrade-minimal (R12); senão "".
- changesCode: true se a decisão exige mudar código, teste ou documentação.
- researchQuestions: com confidence media ou baixa, de 1 a 4 perguntas objetivas cuja resposta resolveria a dúvida, cada uma com kind "external" (doc oficial, lib, API, web) ou "repo" (código, plano, wiki, hexlog). Com alta, lista vazia.
Não edite arquivos.

`
}

function researchPrompt(q, base) {
  const how = q.kind === 'external'
    ? 'externa: documentação oficial (npx ctx7@latest library e docs; ctx_fetch_and_index para páginas) e WebSearch'
    : 'interna: código da worktree, plano, ADRs, wiki (wiki_query) e hexlog'
  return `Você integra o time de pesquisa do decisor autônomo. Responda com evidência primária, sem opinião solta.
Pergunta: ${q.question}
Fonte: ${how}.
Item em decisão:
${base}
Saída: answer (resposta direta e a consequência para a decisão), conclusive (true só se a evidência fecha a pergunta), sources (URL oficial ou arquivo#símbolo). Não edite arquivos.`
}

const JURY_DOCS = '~/.claude/skills/the-jury/SKILL.md, ~/.claude/skills/the-jury/references/juror-archetypes.md e ~/.claude/skills/the-jury/references/deliberation-craft.md'

async function convokeJury(item, base, d, research, phaseTitle) {
  const dossier = `${base}\n\nDecisão provisória do decisor:\n${JSON.stringify(d)}\n\nPesquisa (inconclusiva):\n${JSON.stringify(research)}`
  const framePrompt = `Você é o FOREMAN de um júri no protocolo da skill the-jury: leia ${JURY_DOCS} (fases 0 e 1). Enquadre a decisão abaixo com 2 a 5 opções mutuamente exclusivas e uma rubrica, e monte de 3 a 5 jurados: os papéis obrigatórios proponent (defende a opção líder), devils-advocate (ataca a opção líder ou defende a melhor alternativa) e integrator, mais personas se forem 5. Cada jurado recebe uma lente de método crítico do deliberation-craft (steelman, pre-mortem, red-team, evidence-audit, assumption-surfacing, second-order consequences). Não vote.\n\n${dossier}`
  let frame = await run(framePrompt, { label: `jury:frame:${item.id}`, phase: phaseTitle, schema: JURY_FRAME_SCHEMA })
  if (!frame || !frame.jurors || frame.jurors.length < 3) frame = await run(framePrompt, { label: `jury:frame:${item.id}:retry`, phase: phaseTitle, schema: JURY_FRAME_SCHEMA })
  if (!frame || !frame.jurors || frame.jurors.length < 3) return null
  const jurors = frame.jurors.slice(0, 5)
  const ballot = `Pergunta: ${frame.question}\nOpções: ${frame.options.join(' | ')}\nRubrica: ${frame.rubric}\n\n${dossier}`
  const round1 = await parallel(jurors.map((j, i) => () => run(`Você é o jurado ${i + 1}, papel ${j.role}: ${j.persona}. Lente: ${j.lens}. Protocolo: ${JURY_DOCS}.
Rodada 1, cega: você não vê os outros jurados. Escolha exatamente uma opção, literal; dê confiança de 0 a 100, grau de evidência (A: evidência primária verificada; D: intuição) e as razões. Pode consultar o repositório; não edite arquivos.

${ballot}`, { label: `jury:r1:${item.id}:${i + 1}`, phase: phaseTitle, schema: JUROR1_SCHEMA })))
  const valid = round1.filter(Boolean)
  if (valid.length < 2) {
    log(`jury for ${item.id}: only ${valid.length} valid round-1 votes`)
    return null
  }
  const letters = ['A', 'B', 'C', 'D', 'E']
  const anon = round1.map((v, i) => (v ? `Jurado ${letters[i]}: ${v.choice} (confiança ${v.confidence}, evidência ${v.evidenceGrade}). Razões: ${v.reasons.join('; ')}` : `Jurado ${letters[i]}: sem voto`)).join('\n')
  const round2 = await parallel(jurors.map((j, i) => () => (round1[i]
    ? run(`Você é o jurado ${i + 1}, papel ${j.role}: ${j.persona}. Lente: ${j.lens}. Seu voto na rodada 1: ${JSON.stringify(round1[i])}.
Rodada 2, deliberação anônima. Votos da rodada 1 (anônimos):
${anon}
Primeiro faça o steelman da posição mais forte contra a sua; diga o que mudaria a sua opinião. Mude o voto só com um argumento novo e concreto, escrito em flipReason; maioria não é argumento. Sem argumento novo, repita o voto e deixe flipReason vazio.

${ballot}`, { label: `jury:r2:${item.id}:${i + 1}`, phase: phaseTitle, schema: JUROR2_SCHEMA })
    : Promise.resolve(null))))
  const tallyInput = {
    diversity: jurors.map((j) => `${j.role}: ${j.lens}`),
    jurors: jurors.map((j, i) => (round1[i] ? {
      initial_choice: round1[i].choice,
      initial_confidence: round1[i].confidence,
      final_choice: round2[i] ? round2[i].finalChoice : round1[i].choice,
      final_confidence: round2[i] ? round2[i].finalConfidence : round1[i].confidence,
      flip_reason: round2[i] ? round2[i].flipReason : '',
      evidence_grade: round1[i].evidenceGrade,
    } : null)).filter(Boolean),
  }
  const verdict = await run(`Você é o FOREMAN do júri. Apure no protocolo da skill the-jury (${JURY_DOCS}, fases 4 e 5): grave a entrada abaixo num arquivo temporário e rode "~/.claude/bin/harness skill the-jury tally < <arquivo>". Se o CLI falhar, apure pela regra da skill (peso por confiança; volte à rodada 1 se a deliberação parecer efeito manada; empate se decide pela qualidade do argumento contra a rubrica).
Depois formalize a decisão final no formato do decisor: chosen = a opção vencedora, literal; action, changesCode, deferredTo e contrariesUser coerentes com ela; confidence pela escala da skill convertida (HIGH = alta, MEDIUM = media, LOW ou PIVOT = baixa); justification com as razões vencedoras; juryVerdict com o veredito, a confiança da skill, a fonte do agregado (final ou rodada 1) e o dissenso preservado; researchQuestions vazia.

Entrada do tally:
${JSON.stringify(tallyInput)}

Rodada 2 (steelman e "o que me faria mudar"):
${JSON.stringify(round2)}

${ballot}`, { label: `jury:tally:${item.id}`, phase: phaseTitle, schema: JURY_FINAL_SCHEMA })
  if (!verdict) return null
  return { ...verdict, trail: { frame, round1, round2, tallyInput } }
}

async function decideItem(item, gate, phaseTitle) {
  const base = itemText(item)
  const trail = { item, gate, rounds: [] }
  let d = await run(decisorPrompt(gate) + base, { label: `decisor:${item.id}`, phase: phaseTitle, schema: DECISION_SCHEMA })
  if (!d) throw new Error(`decisor returned nothing for ${item.id}`)
  trail.rounds.push({ stage: 'decisor-1', decision: d })
  let decidedBy = 'decisor'
  let researchTriggered = false
  let researchConclusive
  let juryConvened = false
  let juryVerdict
  if (d.confidence !== 'alta') {
    researchTriggered = true
    const asked = d.researchQuestions && d.researchQuestions.length ? d.researchQuestions : [{ question: `Que evidência resolve: ${item.question}`, kind: 'repo' }]
    const research = (await parallel(asked.slice(0, 4).map((q, i) => () => run(researchPrompt(q, base), {
      label: `research:${item.id}:${i + 1}`,
      phase: phaseTitle,
      agentType: q.kind === 'external' ? 'oh-my-claudecode:document-specialist' : 'oh-my-claudecode:explore',
      schema: RESEARCH_SCHEMA,
    })))).filter(Boolean)
    trail.research = research
    const d2 = await run(`${decisorPrompt(gate)}${base}

Sua decisão antes da pesquisa:
${JSON.stringify(d)}

Resultado do time de pesquisa:
${JSON.stringify(research)}

Redecida com a evidência. researchConclusive = true só se a pesquisa fecha a dúvida.`, { label: `decisor-2:${item.id}`, phase: phaseTitle, schema: REDECISION_SCHEMA })
    if (d2) {
      d = d2
      trail.rounds.push({ stage: 'decisor-2', decision: d2 })
    }
    researchConclusive = Boolean(d2 && d2.researchConclusive)
    if (!researchConclusive) {
      log(`${item.id}: research inconclusive, convening the jury`)
      const j = await convokeJury(item, base, d, research, phaseTitle)
      if (j) {
        const { trail: juryTrail, ...juryDecision } = j
        d = juryDecision
        trail.jury = juryTrail
        juryConvened = true
        juryVerdict = j.juryVerdict
        decidedBy = 'jury'
      } else {
        log(`${item.id}: jury not formed, the decisor's decision stands`)
      }
    }
  }
  const final = { ...d, researchTriggered, researchConclusive, juryConvened, juryVerdict }
  const rec = await record([toEvent({ gate, item: item.id, question: item.question, decidedBy, ...final })], trail, phaseTitle, `record:${gate}/${item.id}`)
  const out = { item, gate, decidedBy, final, record: rec }
  ALL_DECISIONS.push(out)
  return out
}

// Decisão nunca some: duas tentativas e, falhando, adiamento registrado (R12)
// para a conferência da TeamLead.
async function decideSafe(item, gate, phaseTitle) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await decideItem(item, gate, phaseTitle)
    } catch (e) {
      log(`decision ${item.id} failed (attempt ${attempt}): ${e.message}`)
    }
  }
  const final = {
    options: item.options && item.options.length ? item.options : ['adiar'], chosen: 'adiar: o decisor falhou duas vezes', action: 'defer', confidence: 'baixa',
    confidenceReason: 'decisor sem resposta', precedents: [], policyRules: ['R12'], contrariesUser: false, contrariedDecision: '',
    deferredTo: 'conferência da TeamLead e issue de MINIMAL da fase', changesCode: false,
    justification: 'O decisor falhou duas vezes; o item fica adiado com registro durável (R12) para a conferência da TeamLead.',
    researchQuestions: [], researchTriggered: false, juryConvened: false,
  }
  const rec = await record([toEvent({ gate, item: item.id, question: item.question, decidedBy: 'decisor', ...final })], { item, gate, contingency: true }, phaseTitle, `record:${gate}/${item.id}:contingency`)
  const out = { item, gate, decidedBy: 'decisor', final, record: rec, contingency: true }
  ALL_DECISIONS.push(out)
  return out
}

async function decideAll(items, gate, phaseTitle) {
  const docOnly = items.filter((i) => i.docOnly)
  const open = items.filter((i) => !i.docOnly)
  log(`${gate}: ${open.length} items for the decisor, ${docOnly.length} doc-only (R3, no gate)`)
  const decided = (await pipeline(open, (it) => decideSafe(it, gate, phaseTitle))).filter(Boolean)
  if (decided.length !== open.length) log(`${gate}: ${open.length - decided.length} items lost in the pipeline`)
  const docDecided = docOnly.map((it) => ({
    item: it,
    gate,
    decidedBy: 'rule',
    final: {
      options: ['aplicar'], chosen: 'aplicar (só documentação)', action: 'doc-only', confidence: 'alta', confidenceReason: 'R3',
      precedents: [], policyRules: ['R3'], contrariesUser: false, contrariedDecision: '', deferredTo: '', changesCode: true,
      justification: 'R3: achado só de documentação aplica sem gate', researchQuestions: [], researchTriggered: false, juryConvened: false,
    },
  }))
  if (docDecided.length) {
    const rec = await record(docDecided.map((x) => toEvent({ gate, item: x.item.id, question: x.item.question, decidedBy: 'rule', ...x.final })), { gate, docOnly }, phaseTitle, `record:${gate}/doc-only`)
    docDecided.forEach((x) => {
      x.record = rec
      ALL_DECISIONS.push(x)
    })
  }
  return decided.concat(docDecided)
}

async function recordRule(item, question, chosen, justification, phaseTitle) {
  const final = {
    options: [chosen], chosen, action: 'proceed', confidence: 'alta', confidenceReason: 'regra de processo (Q19)',
    precedents: ['spec deliver-v1-autonomo Q19'], policyRules: ['R1'], contrariesUser: false, contrariedDecision: '', deferredTo: '',
    changesCode: false, justification, researchQuestions: [], researchTriggered: false, juryConvened: false,
  }
  const rec = await record([toEvent({ gate: 'process', item, question, decidedBy: 'rule', ...final })], { item, question, chosen, justification }, phaseTitle, `record:process/${item}`)
  ALL_DECISIONS.push({ item: { id: item, question }, gate: 'process', decidedBy: 'rule', final, record: rec })
}

function writeDecisionsPrompt(file, heading, decided) {
  return `Grave as decisões abaixo em ${file}, numa seção nova "${heading}" no fim do arquivo (não apague nada). Uma linha por item: "- **<id>** <aplicado | rebaixado para MINIMAL | descartado | risco aceito | adiado | só documentação>: <o que foi decidido>. Porquê: <justificativa curta>. Decisor: <decidedBy>, confiança <confidence>, hexlog <eventId>." Adiado e rebaixado citam onde o item reaparece. Contrariou decisão do usuário: diga qual. Texto curto em pt-BR, sem travessão.

Decisões:
${JSON.stringify(decided.map((x) => ({ id: x.item.id, decidedBy: x.decidedBy, final: x.final, eventIds: x.record ? x.record.eventIds : [] })))}`
}

async function writeFiles(files, label, phaseTitle) {
  const res = await run(`Grave cada arquivo abaixo no caminho absoluto indicado, com o conteúdo literal (crie a pasta se faltar; sobrescreva só estes caminhos). Devolva em written os caminhos gravados.\n${JSON.stringify(files)}`, { label, phase: phaseTitle, agentType: 'oh-my-claudecode:writer', schema: WRITE_SCHEMA })
  const written = res && res.written ? res.written.length : 0
  if (written < files.length) log(`${label}: wrote ${written} of ${files.length} files`)
  return res
}

// ---- aplicação das decisões ----

function applyPrompt(toApply, why) {
  return `Aplique as decisões abaixo na worktree ${WT}, sem commit. Invoque a skill code-standards antes de escrever código. Para cada item: action apply implementa ou corrige; accept-risk documenta o limite onde a decisão manda (ADR, comentário, AGENTS.md); doc-only ajusta a documentação. Divergência entre o decidido e o aplicado vira registro "deviation" pela hexlog-flow (processo "omc-review" no bloco 3, "omc-exec" no bloco 1; target ${A.target}) e linha na saída.
Ao terminar, rode a suíte (${SUITE}) e devolva suiteGreen, summary, failing (a saída do que falhou, resumida) e deviations.
${why || ''}
Decisões:
${JSON.stringify(toApply.map((x) => ({ id: x.item.id, question: x.item.question, context: x.item.context, final: x.final })))}`
}

async function applyAndGreen(decided, gate, phaseTitle) {
  const toApply = decided.filter((x) => x.final.changesCode || ['apply', 'doc-only', 'accept-risk'].includes(x.final.action))
  if (!toApply.length) {
    log(`${gate}: nothing to apply`)
    return { suiteGreen: true, summary: 'nada a aplicar', failing: '', deviations: [] }
  }
  let res = await run(applyPrompt(toApply), { label: `apply:${gate}`, phase: phaseTitle, agentType: 'oh-my-claudecode:executor', schema: APPLY_SCHEMA })
  for (let i = 1; res && !res.suiteGreen && i <= MAX_SUITE_FIX; i++) {
    log(`${gate}: suite red, fix ${i}/${MAX_SUITE_FIX}`)
    res = await run(`A suíte (${SUITE}) ficou vermelha na worktree ${WT} depois de aplicar decisões. Encontre a causa raiz e corrija, sem commit, sem test.skip e sem afrouxar asserção. Falha anterior:\n${res.failing}`, { label: `suite-fix:${gate}:${i}`, phase: phaseTitle, agentType: 'oh-my-claudecode:executor', schema: APPLY_SCHEMA })
  }
  if (res && res.suiteGreen) return res
  const red = await decideSafe({
    id: `suite-red-${gate}`,
    question: 'A suíte continua vermelha depois do laço de correção. Como seguir?',
    context: res ? res.failing : 'executor sem resposta',
    options: ['corrigir com outra abordagem', 'reverter a mudança que quebrou, registrar scope-cut e abrir follow-up na issue de MINIMAL'],
    recommendation: '',
    docOnly: false,
  }, 'suite-red', phaseTitle)
  const again = await run(applyPrompt([red], 'Esta é a decisão sobre a suíte vermelha: execute-a até a suíte ficar verde.'), { label: `apply:suite-red:${gate}`, phase: phaseTitle, agentType: 'oh-my-claudecode:executor', schema: APPLY_SCHEMA })
  if (!again || !again.suiteGreen) throw new Error(`suite still red after decision "${red.final.chosen}" (${gate}); the team lead takes over`)
  return again
}

// ---- bloco 1: execução (ralph em estágios, Q12) ----

function executorPrompt(story, criteria) {
  return `Você é um executor do ralph em estágios. Implemente a história abaixo na worktree ${WT}, sem commit. Invoque a skill code-standards antes de escrever código. Toque só nos arquivos da história; arquivo compartilhado (AGENTS.md, package.json, índices) é da história de integração.
Divergência do plano não se improvisa: registre em deviations e, se precisar de decisão, em openQuestions. Rode só os specs que você tocou (npx jest <arquivo>); a suíte inteira é da integração.
História ${story.id}: ${story.title}
Arquivos: ${story.files.join(', ')}
Instruções: ${story.instructions}
Critérios da fase: ${criteria.join(' | ')}`
}

async function executeStories() {
  const plan = await run(`Prepare o bloco 1 da fase.
1. Na raiz ${A.repo}: git status --short --branch e wt list. Se a worktree da branch "${A.branch}" não existir, crie pela skill worktrunk a partir de "${A.base}", sem mudar o cwd da sessão (flags de automação da skill). Devolva em worktree o caminho real (esperado ${WT}) e rode npm ci nela; worktree nova vem sem node_modules.
2. Leia o handoff ${HANDOFF}, a seção do plano ${A.repo}/.omc/plans/ralplan-hexlog-1-0.md (§4.3) que começa por "${A.planSection}" e o contrato comum (§4.1). O handoff foi escrito para sessão humana: ignore os trechos que mandam perguntar ao usuário ou chamar o ralph; aqui o ralph é este workflow.
3. Divida a entrega em histórias com conjuntos de arquivos disjuntos, para executores em paralelo (no máximo 8). Arquivos compartilhados (AGENTS.md, package.json, package-lock.json, índices) ficam numa única história com integration true, que roda por último.
4. doneCriteria: os critérios de "Pronto quando" do handoff e de "Saída" da fase, um por item, sem test:budget.
Não implemente nada.`, { label: 'phase-plan', phase: 'Execução', schema: STORIES_SCHEMA })
  if (!plan || !plan.stories || !plan.stories.length) throw new Error('block 1: empty phase plan')
  if (plan.worktree) WT = plan.worktree
  const integration = plan.stories.filter((s) => s.integration)
  const parallelStories = plan.stories.filter((s) => !s.integration)
  log(`block 1: ${parallelStories.length} parallel stories, ${integration.length} integration`)
  const results = (await parallel(parallelStories.map((s) => () => run(executorPrompt(s, plan.doneCriteria), { label: `executor:${s.id}`, phase: 'Execução', agentType: 'oh-my-claudecode:executor', schema: EXEC_SCHEMA })))).filter(Boolean)
  if (results.length < parallelStories.length) log(`block 1: ${parallelStories.length - results.length} executors returned nothing; integration covers the gap`)
  let exec = await run(`Você é o executor de integração. Na worktree ${WT}, sem commit: aplique as histórias de integração abaixo (linhas novas nos AGENTS.md para os arquivos criados, package.json etc.), complete o que algum executor paralelo não entregou, resolva as arestas entre as histórias e deixe a suíte verde (${SUITE}).
Todas as histórias: ${JSON.stringify(plan.stories)}
Resultado das histórias paralelas: ${JSON.stringify(results)}
Critérios da fase: ${plan.doneCriteria.join(' | ')}`, { label: 'executor:integration', phase: 'Execução', agentType: 'oh-my-claudecode:executor', schema: EXEC_SCHEMA })
  let review = null
  for (let i = 1; i <= MAX_RALPH; i++) {
    review = await run(`Você é o architect do ralph em estágios (iteração ${i}). Verifique a entrega da fase na worktree ${WT} contra os critérios abaixo, o plano (§4.1 e a seção que começa por "${A.planSection}") e as fronteiras de camada do repositório. Rode a suíte (${SUITE}) e leia o diff contra "${A.base}". approve só com a suíte verde e todos os critérios cumpridos.
Registre pela hexlog-flow o veredito "completion-verified" (approve ou reject) no processo "omc-exec", target ${A.target}, com supersedes o completion-verified vigente desse target se houver (ache por events); um reject é também "deviation" com trigger "reviewer-reject".
Critérios: ${plan.doneCriteria.join(' | ')}
Último relatório do executor: ${JSON.stringify(exec)}
Não edite código.`, { label: `architect:${i}`, phase: 'Execução', agentType: 'oh-my-claudecode:architect', schema: REVIEW_SCHEMA })
    if (review && review.verdict === 'approve') break
    if (i === MAX_RALPH) {
      log(`ralph: architect did not approve in ${MAX_RALPH} iterations; open findings go to the decisor`)
      break
    }
    log(`ralph ${i}: architect rejected with ${review ? review.findings.length : 0} findings`)
    exec = await run(`Corrija na worktree ${WT}, sem commit, os achados do architect abaixo; mantenha a suíte verde (${SUITE}). Achado que pede decisão (não correção) vai em openQuestions.\nAchados: ${JSON.stringify(review ? review.findings : [])}`, { label: `executor:fix:${i}`, phase: 'Execução', agentType: 'oh-my-claudecode:executor', schema: EXEC_SCHEMA })
  }
  const critic = await run(`Você é o critic do ralph (--critic=critic). Ataque a entrega da fase na worktree ${WT} (diff contra "${A.base}") e as premissas do executor: qualidade, aderência ao plano (§4.1 e a seção que começa por "${A.planSection}"), testes que faltam, fronteiras de camada. Achados por severidade, com arquivo#símbolo. Não edite código.`, { label: 'critic', phase: 'Execução', agentType: 'oh-my-claudecode:critic', schema: REVIEW_SCHEMA })
  const pend = await run(`Grave ${PEND} no formato de ${A.repo}/.omc/handoffs/f2-hexlog-v1-pendencias.md: decisões abertas dos executores e achados do architect e do critic ainda não resolvidos, por severidade, cada um com ID estável (ex.: D1, A-U1, C-N2). Depois devolva os itens a decidir: question (a decisão em uma frase), context (evidência e arquivo#símbolo), options e recommendation quando o achado as trouxer; docOnly true para achado só de documentação.
Executores: ${JSON.stringify(results)}
Integração: ${JSON.stringify(exec)}
Architect (última iteração): ${JSON.stringify(review)}
Critic: ${JSON.stringify(critic)}`, { label: 'pending-items', phase: 'Execução', agentType: 'oh-my-claudecode:writer', schema: ITEMS_SCHEMA })
  return pend ? pend.items : []
}

async function block1(step) {
  phase('Execução')
  if (step !== 'pr') {
    let items
    if (step === 'inicio') {
      items = await executeStories()
    } else {
      const pend = await run(`Bloco 1, retomada: a worktree ${WT} tem mudanças e as pendências não foram decididas. Leia ${PEND} se existir; senão, levante as pendências pelo diff da worktree contra "${A.base}" (decisões abertas, achados sem solução) e grave ${PEND} no formato de ${A.repo}/.omc/handoffs/f2-hexlog-v1-pendencias.md. Devolva os itens a decidir (docOnly true para achado só de documentação).`, { label: 'pending-items:resume', phase: 'Execução', agentType: 'oh-my-claudecode:writer', schema: ITEMS_SCHEMA })
      items = pend ? pend.items : []
    }
    const decided = await decideAll(items, 'pre-pr', 'Decisões')
    if (decided.length) {
      await run(writeDecisionsPrompt(PEND, `## Decisões (${A.date})`, decided), { label: 'write-decisions:pre-pr', phase: 'Decisões', agentType: 'oh-my-claudecode:writer' })
    }
    await applyAndGreen(decided, 'pre-pr', 'Execução')
  }
  const ship = await run(`Gate de processo "commit, push e PR" (regra R1: com a suíte verde, segue). Na worktree ${WT}:
1. Confirme a suíte verde (${SUITE}). Vermelha: não commite e devolva prNumber 0.
2. git status: commite só o que é da fase; .hexlog/flow.md e src/.omc/ ficam fora.
3. Commits Conventional Commits por assunto.
4. git push -u origin '${A.branch}'.
5. PR pelo MCP (create_pull_request): head "${A.branch}", base "${A.base}", título no padrão dos PRs da v1 (veja #66 e #68), corpo pt-BR curto: o que entrega, critérios de saída cumpridos, pendências decididas (caminho de ${PEND}). Sem merge.
6. hexlog-flow: evaluate_gate "completion-verified" no processo "omc-exec", target ${A.target}.`, { label: 'commit-push-pr', phase: 'Execução', agentType: 'oh-my-claudecode:git-master', schema: SHIP_SCHEMA })
  if (!ship || !ship.prNumber) throw new Error('block 1: PR not opened (suite red or push failed); the team lead takes over')
  await recordRule('commit-push-pr', 'Commit, push e PR?', 'seguir: suíte verde', `PR #${ship.prNumber} aberto com base ${A.base}, head ${ship.headSha}`, 'Execução')
  return ship.prNumber
}

// ---- bloco 2: painel (review-pr --panel --normal em estágios, Q12) ----

async function block2(pr) {
  phase('Painel')
  const prep = await run(`Prepare o painel do PR #${pr} no contrato de ~/.claude/skills/review-pr/SKILL.md (fase B) e ~/.claude/skills/review-pr/references/PANEL.md (leia os dois).
1. PRDIR = ${PRDIR(pr)} (crie se faltar). reportFile = review.md, ou review-<k>.md com o próximo k livre se já existir.
2. pull_request_read (get, get_files, get_diff) para o head sha e os arquivos; aplique a ignore list da skill.
3. Rode o scan do the-judge sobre o diff (~/.claude/skills/the-judge/SKILL.md) e devolva os achados em judgeLeads.
4. roles: os especialistas do cast do PANEL.md que o gatilho liga (qa-tester, test-engineer, security-reviewer, document-specialist), com o motivo. Os quatro "always" entram sozinhos.
Não revise ainda.`, { label: 'panel:prep', phase: 'Painel', schema: PANEL_PREP_SCHEMA })
  if (!prep) throw new Error('block 2: empty panel prep')
  const triggered = (prep.roles || []).map((r) => r.role).filter((r) => PANEL_ROLES[r])
  const unknown = (prep.roles || []).map((r) => r.role).filter((r) => !PANEL_ROLES[r])
  if (unknown.length) log(`panel: ignoring unknown roles ${unknown.join(', ')}`)
  const roles = ALWAYS_ROLES.concat(triggered.filter((r) => !ALWAYS_ROLES.includes(r)))
  const panelRef = `Contrato: ~/.claude/skills/review-pr/SKILL.md (fase B: checklist, ignore list, formato do relatório) e ~/.claude/skills/review-pr/references/PANEL.md. PR #${pr} (owner ${OWNER}, repo ${REPO}), head ${prep.headSha}, PRDIR ${prep.prdir}. O código do head está na worktree ${WT}.`
  const base = await run(`Você é o code-reviewer BASE do painel (PANEL.md, Step 1). ${panelRef}
Revise o diff sozinho sob o checklist completo. Pistas do scan do the-judge: ${prep.judgeLeads}
Devolva em markdown o relatório completo no formato da skill (ele vira ${prep.prdir}/base.md) e os achados em findings. Não edite arquivos.`, { label: 'panel:base', phase: 'Painel', agentType: 'oh-my-claudecode:code-reviewer', schema: REPORT_SCHEMA })
  if (!base) throw new Error('block 2: empty base review')
  await writeFiles([{ path: `${prep.prdir}/base.md`, content: base.markdown }], 'panel:write-base', 'Painel')
  const reports = await parallel(roles.map((role) => () => run(`Você é o especialista "${role}" do painel (PANEL.md, Step 2), cego aos colegas. ${panelRef}
Leia ${prep.prdir}/base.md e o diff. Aprofunde achados da base na sua lente, acrescente o que ela perdeu e refute falso positivo em "## Refutações", com o raciocínio. Cada achado traz o tipo de evidência que a sua linha do cast exige.
Devolva em markdown o relatório (## BLOCKING, ## URGENT, ## NORMAL, ## MINIMAL, ## Refutações); ele vira ${prep.prdir}/${role}.md. Não edite arquivos${role === 'qa-tester' ? '. Rode build, CLI e testes na worktree da fase, que já está no head do PR (não crie outra); ao terminar, git status da worktree igual ao do início (apague só o que você gerou)' : ''}.`, { label: `panel:${role}`, phase: 'Painel', agentType: PANEL_ROLES[role], schema: REPORT_SCHEMA })))
  const missing = roles.filter((r, i) => !reports[i])
  if (missing.length) log(`panel: no report from ${missing.join(', ')}`)
  const roleFiles = roles.map((r, i) => (reports[i] ? { path: `${prep.prdir}/${r}.md`, content: reports[i].markdown } : null)).filter(Boolean)
  if (roleFiles.length) await writeFiles(roleFiles, 'panel:write-specialists', 'Painel')
  const synth = await run(`Você é o code-reviewer de SÍNTESE do painel (PANEL.md, Step 3). ${panelRef}
Leia ${prep.prdir}/base.md, os relatórios dos especialistas (${roleFiles.map((f) => f.path).join(', ')}) e o diff. Deduplique, fixe os IDs estáveis (B1, U1, N1, M1...), julgue cada refutação contra o código e devolva em markdown o relatório final no formato da skill, com "## Descartados" (ele vira ${prep.prdir}/${prep.reportFile}). Em findings, todos os achados finais, sem os descartados. Não edite arquivos.`, { label: 'panel:synthesis', phase: 'Painel', agentType: 'oh-my-claudecode:code-reviewer', schema: REPORT_SCHEMA })
  if (!synth) throw new Error('block 2: empty panel synthesis')
  await writeFiles([{ path: `${prep.prdir}/${prep.reportFile}`, content: synth.markdown }], 'panel:write-review', 'Painel')
  const toInvestigate = synth.findings.filter((f) => f.severity !== 'MINIMAL')
  log(`panel: ${synth.findings.length} findings, ${toInvestigate.length} to investigate (--normal), ${roleFiles.length}/${roles.length} specialists`)
  const investigation = await pipeline(toInvestigate, (f) => run(`Investigue o ponto ${f.id} (${f.severity}) da revisão do PR #${pr}, no contrato de ~/.claude/skills/investigate-review-points/SKILL.md (execução de um ponto). ${panelRef}
Ponto: ${f.location}: ${f.summary}
Leia o código em ${WT}, cruze com o diff e as threads do PR (pull_request_read) e feche como FIX concreto (o que mudar e onde) ou PRODUCT_DECISION (a pergunta, as opções e a recomendação). Não edite código.`, { label: `investigate:${f.id}`, phase: 'Painel', agentType: 'oh-my-claudecode:tracer', schema: INVEST_SCHEMA }))
  const uninvestigated = toInvestigate.filter((f, i) => !investigation[i]).map((f) => f.id)
  if (uninvestigated.length) log(`panel: not investigated ${uninvestigated.join(', ')}; block 3 decides them from the review alone`)
  const open = synth.findings.filter((f) => f.severity === 'BLOCKING' || f.severity === 'URGENT')
  const verdictRule = open.length ? 'request_changes' : 'approve'
  const v = await run(`Feche a revisão do PR #${pr} no contrato de ~/.claude/skills/pr-verdict/SKILL.md (Action, Bookkeeping e stop-slop inline). ${panelRef}
O veredito já está decidido pela regra de processo (R1): ${verdictRule} via COMMENT (PR do próprio autor; ${open.length} BLOCKING/URGENT abertos). Não há gate humano. Sem wt remove: a worktree da fase continua.
1. Escreva ${prep.prdir}/investigation.md no formato da skill investigate-review-points, com link relativo para ${prep.reportFile} no topo; pontos sem investigação: ${uninvestigated.join(', ') || 'nenhum'}.
2. Grave em ${prep.prdir}/verdict-comment.md o texto exato que vai postar e poste a review pelo MCP (pull_request_review_write create, add_comment_to_pending_review para os inline, submit com event COMMENT). request_changes: só BLOCKING/URGENT; approve: NORMAL como não bloqueante.
3. Ledger: ~/.claude/bin/harness skill review-ledger record ${pr} <head_sha> ${verdictRule} --repo ${OWNER}/${REPO}
4. ${prep.prdir}/open-items.md com link relativo para investigation.md no topo e os pontos pendentes por ID; ponteiro no índice de memória /home/gabriel/.claude/projects/-home-gabriel-personal-hexlog/memory/MEMORY.md no padrão das entradas existentes.
5. hexlog-flow, processo "omc-review", target ${A.target}: attachment com o texto de ${prep.reportFile}, depois verdict claim "review", result "${verdictRule === 'approve' ? 'approve' : 'request-changes'}", data.attachment = hash.
Investigação: ${JSON.stringify(investigation.filter(Boolean))}`, { label: 'verdict', phase: 'Painel', schema: VERDICT_SCHEMA })
  await recordRule('panel-verdict', 'Veredito do painel', `${verdictRule} via COMMENT`, `${open.length} BLOCKING/URGENT abertos na síntese (R1)`, 'Painel')
  return v
}

// ---- bloco 3: decisões + ajuste ----

async function block3(pr, step) {
  let decided
  if (step === 'entrevista') {
    phase('Decisões')
    const its = await run(`Levante os itens a decidir do PR #${pr}: leia ${PRDIR(pr)}/open-items.md, o relatório final (review.md ou o review-<k>.md mais novo) e investigation.md. Entram os BLOCKING, URGENT e NORMAL ainda sem decisão; MINIMAL não entra (vai para a issue no bloco 4). Para cada um: id (o da síntese), question, context (evidência, arquivo#símbolo e a conclusão da investigação: FIX ou PRODUCT_DECISION), options e recommendation da investigação; docOnly true para achado só de documentação.`, { label: 'review-items', phase: 'Decisões', schema: ITEMS_SCHEMA })
    decided = await decideAll(its ? its.items : [], 'review-item', 'Decisões')
    await run(writeDecisionsPrompt(`${PRDIR(pr)}/open-items.md`, `## Decisões da entrevista item a item (${A.date})`, decided), { label: 'write-decisions:review', phase: 'Decisões', agentType: 'oh-my-claudecode:writer' })
  } else {
    const its = await run(`Bloco 3, retomada no ajuste: leia a seção "## Decisões da entrevista" de ${PRDIR(pr)}/open-items.md e devolva como item cada decisão que exige mudança (aplicado, risco aceito a documentar, só documentação): id, question = a decisão gravada, context = o porquê, options [], recommendation "", docOnly conforme o caso. Rebaixados e descartados não entram.`, { label: 'recorded-decisions', phase: 'Ajuste', schema: ITEMS_SCHEMA })
    decided = (its ? its.items : []).map((it) => ({ item: it, gate: 'review-item', decidedBy: 'decisor', final: { action: it.docOnly ? 'doc-only' : 'apply', changesCode: true, chosen: it.question } }))
  }
  phase('Ajuste')
  await applyAndGreen(decided, 'review-item', 'Ajuste')
  const fx = await run(`Gate de processo "commit e push do ajuste" (R1: suíte verde, segue). Na worktree ${WT}:
1. Confirme a suíte verde (${SUITE}); vermelha: não commite e devolva sha "".
2. Um único commit "fix(<escopo>): apply review fixes to <o quê>" (subject até 80) e git push. Sem nada a commitar (todas as decisões foram adiar, rebaixar ou descartar), faça git commit --allow-empty com "fix(<escopo>): apply review fixes (decisions only)": a retomada da deliver-phase detecta o bloco por esse commit.
3. Comentário-resumo no PR #${pr} (add_issue_comment): o que foi aplicado por ID, o que foi rebaixado ou descartado e o sha.
4. hexlog-flow, processo "omc-review", target ${A.target}: attachment com a seção de decisões de ${PRDIR(pr)}/open-items.md; verdict claim "review", result "approve", supersedes o verdict "review" vigente desse target (ache por events), evidence "decisões aplicadas em <sha>"; depois evaluate_gate "review-approved".`, { label: 'fix-commit', phase: 'Ajuste', agentType: 'oh-my-claudecode:git-master', schema: FIXSHIP_SCHEMA })
  if (!fx || !fx.sha) throw new Error('block 3: fix commit not created (suite red or push failed); the team lead takes over')
  await recordRule('fix-commit', 'Commit e push do ajuste?', 'seguir: suíte verde', `commit ${fx.sha}`, 'Ajuste')
  return fx
}

// ---- bloco 4: fechamento ----

async function block4(pr, step) {
  phase('Fechamento')
  const nextNote = A.nextPhase === 'F9'
    ? `A próxima etapa é humana (F9 e F10). O handoff ${NEXT_HANDOFF} é para o usuário: merge da pilha de PRs na v1 em ordem (merge commit), F10 (fork e rdsc) e o runbook da F9 (§4.3 do plano), com as heranças da v1.`
    : `Handoff ${NEXT_HANDOFF} da fase ${A.nextPhase} no contrato do bloco 4 da skill deliver-phase: bloco pronto para colar no formato de ${A.repo}/.omc/handoffs/v1-f0-ralph.md (Antes de tudo, Execução, Pronto quando, Entrega) apontando a seção da fase no §4.3; herança (decisões que afetam a fase seguinte, issues de MINIMAL abertas, base do PR = "${A.branch}"); seção "Suggested skills" (deliver-phase, worktrunk, hexlog-flow, code-standards); sem pedir test:budget local.`
  const issueStep = step === 'handoff'
    ? `A issue de MINIMAL já existe: ache-a (search_issues MINIMAL "PR #${pr}") e só devolva o número.`
    : `Revalide no head atual de ${WT} o arquivo#símbolo de cada MINIMAL do relatório final de ${PRDIR(pr)} e abra uma issue (issue_write, sem label) no esqueleto das #61, #63, #65 e #67: título "Follow-ups MINIMAL da revisão do PR #${pr} (${A.phase} <tema>)"; abertura com o head revisado e o sha dos ajustes; seções temáticas com "- [ ] **M<k>** arquivo#símbolo: problema + correção"; "## Rebaixados na entrevista" com os itens que o decisor rebaixou; "## Adiados" com os defer e onde reaparecem; rodapé "Origem" com o PR e os review*.md. Anote o número da issue em ${PRDIR(pr)}/open-items.md.`
  const c = await run(`Feche a fase no contrato do bloco 4 de ${A.repo}/.claude/skills/deliver-phase/SKILL.md. Passo de entrada: ${step}.
1. ${issueStep}
2. ${nextNote}
3. hexlog-flow: milestone milestoneType "handoff", target ${A.target}, trace com o caminho do handoff e a URL da issue (processo "omc-review").
4. Wiki: se a fase revelou causa raiz ou armadilha, wiki_add com título que carrega o fato (regra de fechamento do CLAUDE.md global); senão wikiPage "".`, { label: 'closing', phase: 'Fechamento', schema: CLOSE_SCHEMA })
  if (!c) throw new Error('block 4: closing returned nothing; the team lead takes over')
  return c
}

// ---- fluxo ----

const startBlock = Number(A.startBlock)
const defaultStep = { 1: 'inicio', 2: 'painel', 3: 'entrevista', 4: 'issue' }
const step = A.startStep || defaultStep[startBlock]
let pr = A.prNumber ? Number(A.prNumber) : 0
log(`${A.phase}: starting at block ${startBlock} (${step})${pr ? `, PR #${pr}` : ''}`)

const summary = { phase: A.phase, target: A.target, start: { block: startBlock, step }, pr: 0, worktree: WT, verdict: null, fix: null, close: null }
if (startBlock <= 1) pr = await block1(step)
if (!pr) throw new Error('no PR number to continue from block 2')
summary.pr = pr
if (startBlock <= 2) summary.verdict = await block2(pr)
if (startBlock <= 3) summary.fix = await block3(pr, startBlock === 3 ? step : 'entrevista')
summary.close = await block4(pr, startBlock === 4 ? step : 'issue')
summary.worktree = WT

summary.decisions = ALL_DECISIONS.map((d) => ({
  id: d.item.id,
  gate: d.gate,
  chosen: d.final.chosen,
  action: d.final.action,
  confidence: d.final.confidence,
  decidedBy: d.decidedBy,
  research: Boolean(d.final.researchTriggered),
  jury: Boolean(d.final.juryConvened),
  contrariesUser: Boolean(d.final.contrariesUser),
  contingency: Boolean(d.contingency),
  eventIds: d.record ? d.record.eventIds : [],
}))
summary.counts = {
  total: summary.decisions.length,
  research: summary.decisions.filter((d) => d.research).length,
  jury: summary.decisions.filter((d) => d.jury).length,
  contrariesUser: summary.decisions.filter((d) => d.contrariesUser).length,
  lowConfidence: summary.decisions.filter((d) => d.confidence === 'baixa').length,
  contingency: summary.decisions.filter((d) => d.contingency).length,
}
// A TeamLead registra estes no Passo B: decisão sem registro fere Q6.
summary.unrecorded = UNRECORDED
log(`${A.phase}: PR #${pr}, issue #${summary.close.issueNumber}, ${summary.counts.total} decisions (${summary.counts.research} research, ${summary.counts.jury} jury, ${summary.counts.contrariesUser} against the user, ${UNRECORDED.length} unrecorded)`)
return summary
