## Frente: Isolamento no Claude Code

Consolidado de 2 rodadas do agente (claude-code-guide) + verificação direta do orquestrador na doc em markdown (`code.claude.com/docs/en/*.md`, 2026-09-16). Claude Code local: **2.1.273**. `bwrap` e `socat`: **não instalados**.

### 1. Sintaxe de caminho em regras Read/Edit — VERIFICADO
Fonte: https://code.claude.com/docs/en/permissions (seção Read and Edit)

| Pattern | Significado | Exemplo |
|---|---|---|
| `//path` | Absoluto a partir da raiz | `Read(//Users/alice/secrets/**)` |
| `~/path` | A partir do home | `Read(~/Documents/*.pdf)` |
| `/path` | Relativo à origem do settings (user settings → `~/.claude/path`) | `Edit(/src/**/*.ts)` |
| `path` / `./path` | Relativo ao diretório atual | `Read(*.env)` |

> "A pattern like `/Users/alice/file` isn't an absolute path. The single leading slash anchors at the settings source, not the filesystem root. Use `//Users/alice/file` for absolute paths."

> "A deny rule such as `Read(/secrets/**)` in user settings blocks `~/.claude/secrets/**` … use a `//` absolute path or a `~/` home-relative path instead."

**Consequência para o hexlog:** a regra correta é `Read(//home/gabriel/.local/share/hexlog/**)` ou `Read(~/.local/share/hexlog/**)` — mas o diretório vem de `$XDG_DATA_HOME`; o instalador deve resolver o caminho real e gravar a forma `//<absoluto>/**`. `Read(/home/...)` (uma barra) estaria **errado** e silenciosamente ineficaz.

### 2. Alcance do deny de Read — VERIFICADO
- > "`Edit` rules apply to all built-in tools that edit files. Claude makes a best-effort attempt to apply `Read` rules to all built-in tools that read files like Grep and Glob…"
- > "Grep and Glob search the directory the `path` argument resolves to. Claude Code applies `Read` deny rules to that directory."
- > "A `Read` deny rule also blocks the Edit and Write tools on the same path, including creating a new file there. NotebookEdit isn't covered, so add an `Edit` deny rule…" (edits ≥ v2.1.208, writes ≥ v2.1.228)
- Não existe regra `Grep(...)`/`Glob(...)` separada; `Read(...)` cobre.
- Symlinks: deny aplica se o link **ou** o alvo casar.
- Bash (settings-example, comentário): > "Read(./.env) on its own stops the file tools and commands that name the file, such as `cat .env`, but not `grep -r` run over the directory; the `sandbox` block in this file closes that gap, because the sandbox adds your `Read` deny paths to what every sandboxed command can't read."
- Não cobre: comandos que varrem diretório pai (`grep -r ~/.local/share`), `node -e`, `python`, subprocessos em geral — só o sandbox fecha.

### 3. Hook PreToolUse — VERIFICADO
Fonte: https://code.claude.com/docs/en/hooks
- stdin: `hook_event_name`, `tool_name`, `tool_input` (`command` no Bash), `cwd`, entre outros.
- Matcher por nome de tool: `Bash`, `Edit|Write`, `mcp__.*`. Campo opcional `if` (ex.: `"if": "Bash(rm *)"`).
- Decisão via exit 0 + JSON: `hookSpecificOutput.permissionDecision` ∈ `allow|deny|ask|defer` + `permissionDecisionReason`.
- Exit 2: bloqueia a tool call; > "The blocking message is the reason from your JSON's blocking decision when it makes one, and your stderr text otherwise."
- Outros exit codes: erro não-bloqueante (a ação segue) → hook que quebra **falha aberto**.

### 4. Sandbox nativo — VERIFICADO
Fonte: https://code.claude.com/docs/en/sandboxing e settings-reference
- `sandbox.enabled`, `sandbox.filesystem.{denyRead, allowRead, denyWrite, allowWrite, disabled}`, `sandbox.failIfUnavailable`, `sandbox.allowUnsandboxedCommands`, `excludedCommands`.
- O sandbox soma os paths de `Read` deny ao que comandos sandboxed não podem ler.
- Linux/WSL2 exige **`bubblewrap` + `socat`** (ambos ausentes nesta máquina → exige `apt install`, com sudo).
- Sem dependências, por padrão: > "Claude Code shows a warning and runs commands without sandboxing" (a menos que `failIfUnavailable: true`).
- Escape hatch: Claude pode refazer um comando bloqueado com `dangerouslyDisableSandbox`, que passa pelo fluxo normal de permissão; desligável com `"allowUnsandboxedCommands": false`.
- Aplica-se ao Bash tool; servidores MCP stdio não rodam no sandbox do Bash.
- Efeito colateral: sandbox ligado muda o comportamento de TODO comando Bash de TODAS as sessões (rede por allowlist, escrita restrita), não só do hexlog. Troubleshooting cita `jest` precisar de `--no-watchman`.

### 5. Plugins — VERIFICADO
Fonte: https://code.claude.com/docs/en/plugins-reference (tabela de componentes)
- Plugin pode empacotar **Hooks** (`hooks/hooks.json`) e **MCP servers** (`.mcp.json`), além de `bin/` (executáveis no PATH do Bash).
- `settings.json` do plugin: > "Only the `agent` and `subagentStatusLine` keys are supported" → **plugin NÃO registra permissions.deny nem sandbox**.
- `${CLAUDE_PLUGIN_ROOT}` e `${CLAUDE_PLUGIN_DATA}` exportados para hooks e servidores MCP.
- Ativação via `enabledPlugins` (em settings.json) — sujeito ao mesmo risco de regeneração do harness.

### 6. Managed settings — VERIFICADO
Fonte: https://code.claude.com/docs/en/managed-settings
- Linux e WSL: `/etc/claude-code/managed-settings.json`, diretório opcional `/etc/claude-code/managed-settings.d/*.json` (fragmentos mesclados) e `managed-mcp.json`.
- Aceita `permissions.deny` e `sandbox` (exemplos oficiais). Não sobrescrevível por user/project.
- Exige root para escrever em `/etc`. Não é tocado pela reinstalação do harness.

### 7. MCP no escopo user
- `claude mcp add --scope user hexlog -- <comando>` → `~/.claude.json` (`mcpServers`), fora do template do harness.

### 8. Contexto local (rodada 1 do agente)
- `own-harness/boot/settings.template.json` e `~/.claude/settings.json` já têm `permissions.allow/deny` e 2 hooks PreToolUse (gate de comunicação externa + roteamento de Agent). Sem conflito previsível.
- Template com substituição `${VAR}`; `bootstrap.sh` regenera settings.json.

### Mecanismos × requisitos
| Mecanismo | File tools (Read/Grep/Glob/Edit) | `cat <arquivo>` | `grep -r` no pai / `node -e` | Sobrevive a reinstalar harness | Custo |
|---|---|---|---|---|---|
| `permissions.deny` em user settings | ✅ | ✅ (nomeia arquivo) | ❌ | ❌ (regenerado) → script idempotente | baixo |
| Hook PreToolUse Bash (TS) | — | ✅ | parcial (texto) | ❌ em settings / ✅ via plugin se `enabledPlugins` preservado | médio |
| Sandbox `denyRead` | — | ✅ | ✅ | ❌ em user settings / ✅ em managed | sudo p/ bwrap+socat; afeta todas as sessões |
| Managed settings `/etc/claude-code/managed-settings.d/hexlog.json` | ✅ | ✅ | com sandbox ✅ | ✅ | sudo; política global da máquina |
| Plugin hexlog (hooks + MCP) | — | via hook | via hook | depende de `enabledPlugins` | não carrega deny |

### Decisão recomendada
- **Deny:** Adotar `permissions.deny` com `Read(//<dados>/**)` e `Edit(//<dados>/**)` (forma `//` obrigatória).
- **Hook Bash:** Construir (TS) — cobre `cat`/`jq`/`$XDG_DATA_HOME` que o deny sozinho pega só quando o caminho é literal.
- **Sandbox:** candidato forte a camada extra, mas muda todas as sessões e exige sudo → **decisão do usuário**.
- **Distribuição:** script idempotente em user settings (spec atual) vs managed-settings.d (sobrevive ao harness, exige sudo) vs plugin (hook + MCP, sem deny) → **decisão do usuário**.

### Perguntas em aberto para o usuário
1. Ligar o sandbox nativo (instalar bwrap+socat com sudo; afeta todas as sessões)?
2. Onde registrar o deny: user settings via script (spec) ou `/etc/claude-code/managed-settings.d/` (sudo, sobrevive ao harness)?
