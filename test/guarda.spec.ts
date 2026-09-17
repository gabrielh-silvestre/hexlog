import { describe, test, expect, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { quote as shellQuoteQuote } from 'shell-quote';
import {
  regrasEsperadas,
  aplicarGuard,
  verificarGuard,
  executarHookReal,
  sha256,
  type RegrasEsperadas,
  type ItemFaltando,
} from '../src/guarda.ts';

const raizDoRepo = path.resolve(__dirname, '..');

// Settings "reais", sanitizados: só a forma de `permissions` e `hooks.PreToolUse`
// (~/.claude/settings.json), com um comentário pra testar preservação e a
// entrada alheia `rtk hook claude` (~/.claude/settings.json:92-96).
function montarSettingsComRtk(home: string): string {
  return `{
  // comentário de exemplo, precisa sobreviver às edições do jsonc-parser
  "permissions": {
    "allow": ["mcp__hindsight__*"],
    "deny": ["mcp__gitnexus__cypher", "mcp__gitnexus__rename"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "${home}/.claude/bin/harness hook worktree-guard" },
          { "type": "command", "command": "${home}/.claude/bin/harness hook commit-message-guard" }
        ]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{ "type": "command", "command": "rtk hook claude" }]
      }
    ]
  }
}
`;
}

// Equivalente mínimo de `own-harness/boot/settings.template.json:9-15`
// renderizado: uma reinstalação do zero, sem nada do hexlog nem do rtk.
function montarSettingsTemplate(home: string): string {
  return `{
  "permissions": {
    "allow": ["mcp__hindsight__*"],
    "deny": ["mcp__gitnexus__cypher", "mcp__gitnexus__rename"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Agent$",
        "hooks": [{ "type": "command", "command": "${home}/.claude/bin/harness hook agent-concurrency-guard" }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "${home}/.claude/bin/harness hook worktree-guard" },
          { "type": "command", "command": "${home}/.claude/bin/harness hook commit-message-guard" }
        ]
      }
    ]
  }
}
`;
}

// Forma real gravada pelo `claude mcp add` em `~/.claude.json` para um
// servidor stdio (confirmada em `.mcpServers.gitnexus`: `command`+`args`+`env`).
function montarClaudeJsonCompleto(esperado: RegrasEsperadas): string {
  return JSON.stringify({
    mcpServers: { hexlog: { command: esperado.servidorExec, args: [esperado.servidorArquivo], env: {} } },
  });
}

function montarSettingsCompleto(esperadoParaDeny: RegrasEsperadas, comandoHook: string): string {
  return JSON.stringify({
    permissions: {
      deny: [
        esperadoParaDeny.denyReadDir,
        esperadoParaDeny.denyRead,
        esperadoParaDeny.denyEdit,
        esperadoParaDeny.denyEditLib,
      ],
    },
    hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: comandoHook, timeout: 10 }] }] },
  });
}

function existeSempre(): boolean {
  return true;
}

// Simula a semântica do hook real sem executar processo — usado nos testes
// puros de I5/I6, onde só interessa a lógica de `verificarGuard`.
function executarHookSimulado(_exec: string, _arquivo: string, stdin: string): { status: number | null } {
  const { tool_input } = JSON.parse(stdin) as { tool_input: { command: string } };
  return { status: tool_input.command.includes('/sonda') ? 2 : 0 };
}

describe('I5: aplicarGuard idempotente e não intrusivo', () => {
  const home = '/home/usuario-teste';
  const D = path.join(home, '.local', 'share', 'hexlog');
  const esperado = regrasEsperadas(D, home, '/usr/bin/node', '0.1.0');

  test('aplicarGuard duas vezes produz o mesmo texto', () => {
    const primeira = aplicarGuard(montarSettingsTemplate(home), esperado);
    const segunda = aplicarGuard(primeira, esperado);
    expect(segunda).toBe(primeira);
  });

  test('sobre o settings regenerado do template, restaura as 4 regras e o hook', () => {
    const resultado = aplicarGuard(montarSettingsTemplate(home), esperado);
    const verificacao = verificarGuard({
      textoSettings: resultado,
      textoClaudeJson: montarClaudeJsonCompleto(esperado),
      esperado,
      existe: existeSempre,
      executarHook: executarHookSimulado,
    });
    expect(verificacao).toEqual({ ok: true, faltando: [], avisos: [] });
  });

  test('preserva entradas alheias (rtk hook claude e as regras/allow existentes)', () => {
    const resultado = aplicarGuard(montarSettingsComRtk(home), esperado);
    const dados = parseJsonc(resultado);
    expect(dados.permissions.allow).toEqual(['mcp__hindsight__*']);
    expect(dados.permissions.deny).toEqual(
      expect.arrayContaining(['mcp__gitnexus__cypher', 'mcp__gitnexus__rename']),
    );
    const entradasBash = dados.hooks.PreToolUse.filter((entrada: { matcher: string }) => entrada.matcher === '^Bash$');
    const comandos = entradasBash.flatMap((entrada: { hooks: { command: string }[] }) =>
      entrada.hooks.map((h) => h.command),
    );
    expect(comandos).toContain('rtk hook claude');
    expect(comandos).toContain(`${home}/.claude/bin/harness hook worktree-guard`);
    expect(comandos).toContain(`${home}/.claude/bin/harness hook commit-message-guard`);
  });

  test('substitui a entrada com command de versão antiga sem duplicar', () => {
    const esperadoAntigo = regrasEsperadas(D, home, '/usr/bin/node', '0.0.9');
    const comVersaoAntiga = aplicarGuard(montarSettingsTemplate(home), esperadoAntigo);
    const resultado = aplicarGuard(comVersaoAntiga, esperado);
    const dados = parseJsonc(resultado);
    const entradasDoHexlog = dados.hooks.PreToolUse.filter((entrada: { hooks: { command: string }[] }) =>
      entrada.hooks.some((h) => typeof h.command === 'string' && h.command.includes('guarda-bash.mjs')),
    );
    expect(entradasDoHexlog).toHaveLength(1);
    expect(entradasDoHexlog[0].hooks[0].command).toBe(esperado.hookCommand);
  });

  test('JSON resultante é válido e preserva comentários existentes', () => {
    const resultado = aplicarGuard(montarSettingsComRtk(home), esperado);
    const erros: ParseError[] = [];
    parseJsonc(resultado, erros);
    expect(erros).toHaveLength(0);
    expect(resultado).toContain('// comentário de exemplo');
  });

  test('settings sem comentários continua JSON.parse válido depois de aplicarGuard', () => {
    const resultado = aplicarGuard(montarSettingsTemplate(home), esperado);
    expect(() => JSON.parse(resultado)).not.toThrow();
  });

  test('verificarGuard lista cada regra de deny quando removida individualmente', () => {
    const completo = aplicarGuard(montarSettingsTemplate(home), esperado);
    const claudeJson = montarClaudeJsonCompleto(esperado);
    const casos: [string, ItemFaltando][] = [
      [esperado.denyReadDir, 'deny-read-dir'],
      [esperado.denyRead, 'deny-read'],
      [esperado.denyEdit, 'deny-edit'],
      [esperado.denyEditLib, 'deny-edit-lib'],
    ];
    for (const [regra, item] of casos) {
      const dados = parseJsonc(completo);
      dados.permissions.deny = dados.permissions.deny.filter((r: string) => r !== regra);
      const verificacao = verificarGuard({
        textoSettings: JSON.stringify(dados),
        textoClaudeJson: claudeJson,
        esperado,
        existe: existeSempre,
        executarHook: executarHookSimulado,
      });
      expect(verificacao.faltando).toContain(item);
    }
  });

  test('verificarGuard aponta "hook" quando a entrada do hook é removida', () => {
    const completo = aplicarGuard(montarSettingsTemplate(home), esperado);
    const dados = parseJsonc(completo);
    dados.hooks.PreToolUse = dados.hooks.PreToolUse.filter(
      (entrada: { hooks: { command: string }[] }) =>
        !entrada.hooks.some((h) => typeof h.command === 'string' && h.command.includes('guarda-bash.mjs')),
    );
    const verificacao = verificarGuard({
      textoSettings: JSON.stringify(dados),
      textoClaudeJson: montarClaudeJsonCompleto(esperado),
      esperado,
      existe: existeSempre,
      executarHook: executarHookSimulado,
    });
    expect(verificacao.faltando).toContain('hook');
  });
});

describe('I6: as 4 regras de deny exatas (QN4)', () => {
  const home = '/home/usuario-teste';
  const D = path.join(home, '.local', 'share', 'hexlog');
  const esperado = regrasEsperadas(D, home, '/usr/bin/node', '0.1.0');

  test('as 4 regras têm o texto exato esperado pelo plano', () => {
    expect(esperado.denyReadDir).toBe(`Read(/${D})`);
    expect(esperado.denyRead).toBe(`Read(/${D}/**)`);
    expect(esperado.denyEdit).toBe(`Edit(/${D}/**)`);
    expect(esperado.denyEditLib).toBe(`Edit(/${home}/.local/lib/hexlog/**)`);
  });

  test('nenhuma regra usa barra única (o prefixo é sempre "//")', () => {
    for (const regra of [esperado.denyReadDir, esperado.denyRead, esperado.denyEdit, esperado.denyEditLib]) {
      expect(regra).toMatch(/^(Read|Edit)\(\/\//);
    }
  });

  test('nenhuma regra Read cobre .local/lib/hexlog (leitura do artefato instalado continua liberada)', () => {
    expect(esperado.denyReadDir).not.toContain('.local/lib/hexlog');
    expect(esperado.denyRead).not.toContain('.local/lib/hexlog');
  });

  test('sem a quarta regra, verificarGuard aponta deny-edit-lib', () => {
    const completo = aplicarGuard(montarSettingsTemplate(home), esperado);
    const dados = parseJsonc(completo);
    dados.permissions.deny = dados.permissions.deny.filter((r: string) => r !== esperado.denyEditLib);
    const verificacao = verificarGuard({
      textoSettings: JSON.stringify(dados),
      textoClaudeJson: montarClaudeJsonCompleto(esperado),
      esperado,
      existe: existeSempre,
      executarHook: executarHookSimulado,
    });
    expect(verificacao.faltando).toEqual(['deny-edit-lib']);
  });
});

describe('I7: verificação com execução real do hook instalado', () => {
  // Prefixo com espaço (Critic iter3-7): o `command` do settings precisa
  // sobreviver ao ciclo `shellQuote.quote` (instalador) → `shellQuote.parse`
  // (verificação) mesmo com espaço no caminho do HOME.
  const homeComEspaco = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog casa-'));
  const D = path.join(homeComEspaco, '.local', 'share', 'hexlog');
  const versao = '0.1.0';
  const esperado = regrasEsperadas(D, homeComEspaco, process.execPath, versao);

  // `executarHookReal` roda o hook num processo filho que herda `process.env`
  // (mesmo contrato de produção, onde o instalador roda como o usuário real):
  // pra `D` bater com o que o hook calcula, o `HOME` do processo de teste
  // precisa apontar pro `HOME` temporário enquanto este describe roda.
  const homeOriginal = process.env.HOME;
  const xdgOriginal = process.env.XDG_DATA_HOME;
  process.env.HOME = homeComEspaco;
  delete process.env.XDG_DATA_HOME;

  const outdirBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-guarda-bundle-'));
  const build = spawnSync(
    process.execPath,
    [path.join(raizDoRepo, 'test/fixtures/construir-hook.ts'), outdirBundle],
    { encoding: 'utf8', cwd: raizDoRepo },
  );
  if (build.status !== 0) {
    throw new Error(`build do hook falhou: ${build.stderr}`);
  }
  const bundleReal = fs.readFileSync(path.join(outdirBundle, 'guarda-bash.mjs'));

  fs.mkdirSync(path.dirname(esperado.hookArquivo), { recursive: true });
  fs.writeFileSync(esperado.hookArquivo, bundleReal);

  const variantes: { versao: string; conteudo: string }[] = [
    { versao: '0.1.0-erro', conteudo: 'isto não é ( javascript válido {{{\n' },
    { versao: '0.1.0-sempre-zero', conteudo: 'process.exitCode = 0;\n' },
    { versao: '0.1.0-sempre-dois', conteudo: "process.stderr.write('nega tudo'); process.exitCode = 2;\n" },
  ];
  const esperadosVariantes = new Map<string, RegrasEsperadas>();
  for (const variante of variantes) {
    const esperadoVariante = regrasEsperadas(D, homeComEspaco, process.execPath, variante.versao);
    fs.mkdirSync(path.dirname(esperadoVariante.hookArquivo), { recursive: true });
    fs.writeFileSync(esperadoVariante.hookArquivo, variante.conteudo);
    esperadosVariantes.set(variante.versao, esperadoVariante);
  }

  afterAll(() => {
    fs.rmSync(homeComEspaco, { recursive: true, force: true });
    fs.rmSync(outdirBundle, { recursive: true, force: true });
    process.env.HOME = homeOriginal;
    if (xdgOriginal === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = xdgOriginal;
    }
  });

  test('hook real instalado: faltando vazio quando settings e claude.json estão completos', () => {
    const settings = montarSettingsCompleto(esperado, esperado.hookCommand);
    const verificacao = verificarGuard({
      textoSettings: settings,
      textoClaudeJson: montarClaudeJsonCompleto(esperado),
      esperado,
      existe: fs.existsSync,
      executarHook: executarHookReal,
    });
    expect(verificacao).toEqual({ ok: true, faltando: [], avisos: [] });
  });

  const casosDeFuncional: { nome: string; versaoVariante: string; item: ItemFaltando }[] = [
    { nome: 'cópia com erro de sintaxe', versaoVariante: '0.1.0-erro', item: 'hook-nao-nega' },
    { nome: 'script que sempre sai 0', versaoVariante: '0.1.0-sempre-zero', item: 'hook-nao-nega' },
    { nome: 'script que sempre sai 2', versaoVariante: '0.1.0-sempre-dois', item: 'hook-nao-permite' },
  ];
  for (const caso of casosDeFuncional) {
    test(`checagem funcional real: ${caso.nome} → ${caso.item}`, () => {
      const esperadoVariante = esperadosVariantes.get(caso.versaoVariante)!;
      const settings = montarSettingsCompleto(esperado, esperadoVariante.hookCommand);
      const verificacao = verificarGuard({
        textoSettings: settings,
        textoClaudeJson: montarClaudeJsonCompleto(esperado),
        esperado,
        existe: fs.existsSync,
        executarHook: executarHookReal,
      });
      expect(verificacao.faltando).toContain(caso.item);
    });
  }

  test('hook-arquivo quando o arquivo registrado não existe', () => {
    const esperadoNaoInstalado = regrasEsperadas(D, homeComEspaco, process.execPath, 'versao-nao-instalada');
    const settings = montarSettingsCompleto(esperado, esperadoNaoInstalado.hookCommand);
    const verificacao = verificarGuard({
      textoSettings: settings,
      textoClaudeJson: montarClaudeJsonCompleto(esperado),
      esperado: esperadoNaoInstalado,
      existe: fs.existsSync,
      executarHook: executarHookReal,
    });
    expect(verificacao.faltando).toContain('hook-arquivo');
  });

  test('node quando o executável registrado não existe', () => {
    const execInexistente = path.join(homeComEspaco, 'bin-que-nao-existe', 'node');
    const comandoComExecFalso = shellQuoteQuote([execInexistente, esperado.hookArquivo]);
    const settings = montarSettingsCompleto(esperado, comandoComExecFalso);
    const verificacao = verificarGuard({
      textoSettings: settings,
      textoClaudeJson: montarClaudeJsonCompleto(esperado),
      esperado,
      existe: fs.existsSync,
      executarHook: executarHookReal,
    });
    expect(verificacao.faltando).toContain('node');
  });

  test('command que não vira exatamente [exec, arquivo] sob .local/lib/hexlog → hook', () => {
    for (const comando of ['bash -c true', `${process.execPath} /tmp/nada-a-ver.mjs`]) {
      const settings = montarSettingsCompleto(esperado, comando);
      const verificacao = verificarGuard({
        textoSettings: settings,
        textoClaudeJson: montarClaudeJsonCompleto(esperado),
        esperado,
        existe: fs.existsSync,
        executarHook: executarHookReal,
      });
      expect(verificacao.faltando).toContain('hook');
    }
  });

  test('artefato-alterado quando o hash do hook instalado diverge do manifesto', () => {
    const settings = montarSettingsCompleto(esperado, esperado.hookCommand);
    const manifestoDivergente = {
      sha256: { servidor: sha256(Buffer.from('servidor esperado')), hook: sha256(Buffer.from('bytes diferentes')) },
    };
    const verificacao = verificarGuard({
      textoSettings: settings,
      textoClaudeJson: montarClaudeJsonCompleto(esperado),
      esperado,
      existe: fs.existsSync,
      executarHook: executarHookReal,
      bytesInstalados: { servidor: null, hook: bundleReal, manifesto: manifestoDivergente },
    });
    expect(verificacao.faltando).toContain('artefato-alterado');
  });

  test('mcp quando o claude.json é nulo ou não aponta para o servidor instalado', () => {
    const settings = montarSettingsCompleto(esperado, esperado.hookCommand);
    const claudeJsonErrado = JSON.stringify({
      mcpServers: { hexlog: { command: esperado.servidorExec, args: ['/caminho/errado/servidor.mjs'] } },
    });
    for (const textoClaudeJson of [null, claudeJsonErrado]) {
      const verificacao = verificarGuard({
        textoSettings: settings,
        textoClaudeJson,
        esperado,
        existe: fs.existsSync,
        executarHook: executarHookReal,
      });
      expect(verificacao.faltando).toContain('mcp');
    }
  });
});
