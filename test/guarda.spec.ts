import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { quote as shellQuoteQuote } from 'shell-quote';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  regrasEsperadas,
  aplicarGuard,
  verificarGuard,
  executarHookReal,
  sha256,
  type RegrasEsperadas,
  type ItemFaltando,
} from '../src/guarda.ts';
import {
  dirVersaoDe,
  lerManifesto,
  instalarArtefato,
  registrarGuard,
  verificarInstalacao,
  type Bundles,
} from '../src/instalacao.ts';
import { parseJson } from './helpers.ts';

const raizDoRepo = path.resolve(__dirname, '..');

// Forma mínima de `~/.claude/settings.json` lida nos testes: só os campos
// que as asserções acessam, com passthrough pro resto (timeout, etc.).
const esquemaSettings = z.looseObject({
  permissions: z.looseObject({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  hooks: z.looseObject({
    PreToolUse: z.array(
      z.looseObject({
        matcher: z.string(),
        hooks: z.array(z.looseObject({ command: z.string() })),
      }),
    ),
  }),
});

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
    mcpServers: {
      hexlog: { command: esperado.servidorExec, args: [esperado.servidorArquivo], env: {} },
    },
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
    hooks: {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: comandoHook, timeout: 10 }] },
      ],
    },
  });
}

function existeSempre(): boolean {
  return true;
}

// Simula a semântica do hook real sem executar processo — usado nos testes
// puros de I5/I6, onde só interessa a lógica de `verificarGuard`.
function executarHookSimulado(
  _exec: string,
  _arquivo: string,
  stdin: string,
): { status: number | null } {
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
    expect(verificacao).toEqual({ ok: true, faltando: [] });
  });

  test('preserva entradas alheias (rtk hook claude e as regras/allow existentes)', () => {
    const resultado = aplicarGuard(montarSettingsComRtk(home), esperado);
    const dados = parseJson(esquemaSettings, resultado);
    expect(dados.permissions.allow).toEqual(['mcp__hindsight__*']);
    expect(dados.permissions.deny).toEqual(
      expect.arrayContaining(['mcp__gitnexus__cypher', 'mcp__gitnexus__rename']),
    );
    const entradasBash = dados.hooks.PreToolUse.filter(
      (entrada: { matcher: string }) => entrada.matcher === '^Bash$',
    );
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
    const dados = parseJson(esquemaSettings, resultado);
    const entradasDoHexlog = dados.hooks.PreToolUse.filter(
      (entrada: { hooks: { command: string }[] }) =>
        entrada.hooks.some(
          (h) => typeof h.command === 'string' && h.command.includes('guarda-bash.mjs'),
        ),
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
    expect(() => {
      JSON.parse(resultado);
    }).not.toThrow();
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
      const dados = parseJson(esquemaSettings, completo);
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
    const dados = parseJson(esquemaSettings, completo);
    dados.hooks.PreToolUse = dados.hooks.PreToolUse.filter(
      (entrada: { hooks: { command: string }[] }) =>
        !entrada.hooks.some(
          (h) => typeof h.command === 'string' && h.command.includes('guarda-bash.mjs'),
        ),
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
    for (const regra of [
      esperado.denyReadDir,
      esperado.denyRead,
      esperado.denyEdit,
      esperado.denyEditLib,
    ]) {
      expect(regra).toMatch(/^(Read|Edit)\(\/\//);
    }
  });

  test('nenhuma regra Read cobre .local/lib/hexlog (leitura do artefato instalado continua liberada)', () => {
    expect(esperado.denyReadDir).not.toContain('.local/lib/hexlog');
    expect(esperado.denyRead).not.toContain('.local/lib/hexlog');
  });

  test('sem a quarta regra, verificarGuard aponta deny-edit-lib', () => {
    const completo = aplicarGuard(montarSettingsTemplate(home), esperado);
    const dados = parseJson(esquemaSettings, completo);
    dados.permissions.deny = dados.permissions.deny.filter(
      (r: string) => r !== esperado.denyEditLib,
    );
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
    {
      versao: '0.1.0-sempre-dois',
      conteudo: "process.stderr.write('nega tudo'); process.exitCode = 2;\n",
    },
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
    expect(verificacao).toEqual({ ok: true, faltando: [] });
  });

  const casosDeFuncional: { nome: string; versaoVariante: string; item: ItemFaltando }[] = [
    { nome: 'cópia com erro de sintaxe', versaoVariante: '0.1.0-erro', item: 'hook-nao-nega' },
    { nome: 'script que sempre sai 0', versaoVariante: '0.1.0-sempre-zero', item: 'hook-nao-nega' },
    {
      nome: 'script que sempre sai 2',
      versaoVariante: '0.1.0-sempre-dois',
      item: 'hook-nao-permite',
    },
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
    const esperadoNaoInstalado = regrasEsperadas(
      D,
      homeComEspaco,
      process.execPath,
      'versao-nao-instalada',
    );
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
      sha256: {
        servidor: sha256(Buffer.from('servidor esperado')),
        hook: sha256(Buffer.from('bytes diferentes')),
      },
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
      mcpServers: {
        hexlog: { command: esperado.servidorExec, args: ['/caminho/errado/servidor.mjs'] },
      },
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

// Bundles reais construídos uma vez (esbuild custa ~1s) e reaproveitados por
// todos os casos de B2/B3 que não precisam de um build "diferente" de propósito.
let bundlesReais: Bundles;
let outdirBundlesReais: string;

beforeAll(() => {
  outdirBundlesReais = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-build-'));
  const build = spawnSync(
    process.execPath,
    [path.join(raizDoRepo, 'scripts/build.ts'), '--outdir', outdirBundlesReais],
    {
      encoding: 'utf8',
      cwd: raizDoRepo,
    },
  );
  if (build.status !== 0) {
    throw new Error(`build para B2/B3 falhou: ${build.stderr}`);
  }
  bundlesReais = {
    servidor: fs.readFileSync(path.join(outdirBundlesReais, 'servidor.mjs')),
    hook: fs.readFileSync(path.join(outdirBundlesReais, 'guarda-bash.mjs')),
  };
}, 30_000);

afterAll(() => {
  fs.rmSync(outdirBundlesReais, { recursive: true, force: true });
});

// Roda o hook preparado (real) exatamente como `scripts/instalar.ts` injetaria.
const executarHookReaisDeInstalacao = (
  arquivoHook: string,
  stdin: string,
): { status: number | null } => executarHookReal(process.execPath, arquivoHook, stdin);

/** Sobe o servidor preparado num HOME/XDG_DATA_HOME descartáveis e conta as tools anunciadas (uso real, B2(a)). */
async function contarToolsReal(arquivoServidor: string): Promise<number> {
  const homeDescartavel = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-verifica-'));
  try {
    const transporte = new StdioClientTransport({
      command: process.execPath,
      args: [arquivoServidor],
      env: { HOME: homeDescartavel, XDG_DATA_HOME: path.join(homeDescartavel, 'dados') },
    });
    const cliente = new Client({ name: 'teste-instalacao', version: '0.0.0' });
    await cliente.connect(transporte);
    const { tools } = await cliente.listTools();
    await cliente.close();
    return tools.length;
  } finally {
    fs.rmSync(homeDescartavel, { recursive: true, force: true });
  }
}

const verificarServidorFalso = (): Promise<number> => Promise.resolve(10);

function executarFixtureConcorrente(
  home: string,
  versao: string,
  variante: string,
  idProcesso: number,
  totalProcessos: number,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const filho = spawn(
      process.execPath,
      [
        path.join(raizDoRepo, 'test/fixtures/instalar-concorrente.ts'),
        home,
        versao,
        variante,
        String(idProcesso),
        String(totalProcessos),
      ],
      { cwd: raizDoRepo },
    );
    let stdout = '';
    filho.stdout.on('data', (d) => (stdout += d));
    filho.on('error', reject);
    filho.on('close', (status) => resolve({ status, stdout }));
  });
}

describe('B2: instalação versionada do artefato (instalarArtefato)', () => {
  test('(a) instala em <HOME>/.local/lib/hexlog/<versão>/ com os 2 bundles e manifesto.json (Client real)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-a-'));
    try {
      const resultado = await instalarArtefato({
        home,
        versao: '0.1.0',
        bundles: bundlesReais,
        commit: 'commit-de-teste',
        sujo: false,
        agora: () => new Date('2026-01-01T00:00:00.000Z'),
        executarHook: executarHookReaisDeInstalacao,
        verificarServidor: contarToolsReal,
        log: () => {},
      });
      expect(resultado.acao).toBe('instalado');
      const dirVersao = dirVersaoDe(home, '0.1.0');
      expect(resultado.dirVersao).toBe(dirVersao);
      expect(fs.existsSync(path.join(dirVersao, 'servidor.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(dirVersao, 'guarda-bash.mjs'))).toBe(true);
      expect(lerManifesto(dirVersao)).toEqual({
        versao: '0.1.0',
        sha256: { servidor: sha256(bundlesReais.servidor), hook: sha256(bundlesReais.hook) },
        construidoEm: '2026-01-01T00:00:00.000Z',
        commit: 'commit-de-teste',
        sujo: false,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(b) registrarGuard aplica as 4 regras de deny e o hook apontando pro dirVersao instalado', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-b-'));
    try {
      const D = path.join(home, '.local', 'share', 'hexlog');
      const esperado = regrasEsperadas(D, home, process.execPath, '0.1.0');
      const caminhoSettings = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(caminhoSettings), { recursive: true });
      fs.writeFileSync(caminhoSettings, montarSettingsTemplate(home));

      const { mudou } = registrarGuard({ caminhoSettings, esperado });
      expect(mudou).toBe(true);

      const textoFinal = fs.readFileSync(caminhoSettings, 'utf8');
      const dados = parseJson(esquemaSettings, textoFinal);
      expect(dados.permissions.deny).toEqual(
        expect.arrayContaining([
          esperado.denyReadDir,
          esperado.denyRead,
          esperado.denyEdit,
          esperado.denyEditLib,
        ]),
      );
      expect(textoFinal).toContain(esperado.hookCommand);
      expect(textoFinal).not.toContain('personal/hexlog');
      expect(fs.existsSync(`${caminhoSettings}.bak-hexlog`)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('(c) segunda execução sem mudança decide pelos bytes instalados: nada, settings e mtime intocados', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-c-'));
    try {
      const args = {
        home,
        versao: '0.1.0',
        bundles: bundlesReais,
        commit: 'c1',
        sujo: false,
        agora: () => new Date(),
        executarHook: executarHookReaisDeInstalacao,
        verificarServidor: verificarServidorFalso,
        log: () => {},
      };
      const primeira = await instalarArtefato(args);
      const mtimeAntes = fs.statSync(primeira.dirVersao).mtimeMs;

      const D = path.join(home, '.local', 'share', 'hexlog');
      const esperado = regrasEsperadas(D, home, process.execPath, '0.1.0');
      const caminhoSettings = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(caminhoSettings), { recursive: true });
      fs.writeFileSync(caminhoSettings, montarSettingsTemplate(home));
      registrarGuard({ caminhoSettings, esperado });
      const settingsAntes = fs.readFileSync(caminhoSettings, 'utf8');

      const segunda = await instalarArtefato(args);
      expect(segunda).toEqual({
        acao: 'nada',
        dirVersao: primeira.dirVersao,
        manifesto: primeira.manifesto,
        avisos: [],
      });
      expect(fs.statSync(primeira.dirVersao).mtimeMs).toBe(mtimeAntes);
      expect(fs.readFileSync(caminhoSettings, 'utf8')).toBe(settingsAntes);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(d) versão nova cria diretório novo, mantém o antigo e substitui a entrada do hook sem duplicar', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-d-'));
    try {
      const argsPara = (versao: string) => ({
        home,
        versao,
        bundles: bundlesReais,
        commit: null,
        sujo: false,
        agora: () => new Date(),
        executarHook: executarHookReaisDeInstalacao,
        verificarServidor: verificarServidorFalso,
        log: () => {},
      });
      const primeira = await instalarArtefato(argsPara('0.1.0'));
      const segunda = await instalarArtefato(argsPara('0.2.0'));
      expect(segunda.acao).toBe('instalado');
      expect(fs.existsSync(primeira.dirVersao)).toBe(true);
      expect(fs.existsSync(segunda.dirVersao)).toBe(true);

      const D = path.join(home, '.local', 'share', 'hexlog');
      const caminhoSettings = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(caminhoSettings), { recursive: true });
      fs.writeFileSync(caminhoSettings, montarSettingsTemplate(home));
      registrarGuard({
        caminhoSettings,
        esperado: regrasEsperadas(D, home, process.execPath, '0.1.0'),
      });
      registrarGuard({
        caminhoSettings,
        esperado: regrasEsperadas(D, home, process.execPath, '0.2.0'),
      });

      const dados = parseJson(esquemaSettings, fs.readFileSync(caminhoSettings, 'utf8'));
      const entradasDoHexlog = dados.hooks.PreToolUse.filter(
        (entrada: { hooks: { command: string }[] }) =>
          entrada.hooks.some(
            (h) => typeof h.command === 'string' && h.command.includes('guarda-bash.mjs'),
          ),
      );
      expect(entradasDoHexlog).toHaveLength(1);
      expect(entradasDoHexlog[0].hooks[0].command).toContain('0.2.0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(e) mesma versão reinstalada com bundles diferentes troca atomicamente e avisa', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-e-'));
    try {
      const argsPara = (bundles: Bundles) => ({
        home,
        versao: '0.1.0',
        bundles,
        commit: 'c',
        sujo: false,
        agora: () => new Date(),
        executarHook: executarHookReaisDeInstalacao,
        verificarServidor: verificarServidorFalso,
        log: () => {},
      });
      await instalarArtefato(argsPara(bundlesReais));
      const hookDiferente = Buffer.concat([
        bundlesReais.hook,
        Buffer.from('\n// bytes diferentes\n'),
      ]);
      const resultado = await instalarArtefato(
        argsPara({ servidor: bundlesReais.servidor, hook: hookDiferente }),
      );

      expect(resultado.acao).toBe('reinstalado');
      expect(resultado.avisos).toEqual(
        expect.arrayContaining([expect.stringContaining('reinstalada com conteúdo diferente')]),
      );
      expect(fs.readFileSync(path.join(resultado.dirVersao, 'guarda-bash.mjs'))).toEqual(
        hookDiferente,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(f) qualquer falha na verificação do preparo aborta sem tocar no que já estava instalado', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-f-'));
    try {
      const argsBase = {
        home,
        versao: '0.1.0',
        commit: null,
        sujo: false,
        agora: () => new Date(),
        log: () => {},
      };

      // hook preparado que não nega (cópia que sempre "permite")
      await expect(
        instalarArtefato({
          ...argsBase,
          bundles: bundlesReais,
          executarHook: () => ({ status: 0 }),
          verificarServidor: verificarServidorFalso,
        }),
      ).rejects.toThrow(/não nega/);
      expect(fs.existsSync(dirVersaoDe(home, '0.1.0'))).toBe(false);
      expect(fs.readdirSync(path.join(home, '.local', 'lib', 'hexlog'))).toEqual([]);

      // bundle com "Dynamic require of"
      const bundleComDynamicRequire = Buffer.concat([
        bundlesReais.servidor,
        Buffer.from('\n// Dynamic require of "x" is not supported\n'),
      ]);
      await expect(
        instalarArtefato({
          ...argsBase,
          bundles: { servidor: bundleComDynamicRequire, hook: bundlesReais.hook },
          executarHook: executarHookReaisDeInstalacao,
          verificarServidor: verificarServidorFalso,
        }),
      ).rejects.toThrow(/Dynamic require of/);
      expect(fs.existsSync(dirVersaoDe(home, '0.1.0'))).toBe(false);

      // servidor preparado que não lista as 10 tools
      await expect(
        instalarArtefato({
          ...argsBase,
          bundles: bundlesReais,
          executarHook: executarHookReaisDeInstalacao,
          verificarServidor: () => Promise.resolve(9),
        }),
      ).rejects.toThrow(/9 tools/);
      expect(fs.existsSync(dirVersaoDe(home, '0.1.0'))).toBe(false);

      // instala com sucesso e confirma que uma falha subsequente não mexe no que já está instalado
      const instalada = await instalarArtefato({
        ...argsBase,
        bundles: bundlesReais,
        executarHook: executarHookReaisDeInstalacao,
        verificarServidor: verificarServidorFalso,
      });
      const hookAntes = fs.readFileSync(path.join(instalada.dirVersao, 'guarda-bash.mjs'));
      await expect(
        instalarArtefato({
          ...argsBase,
          bundles: {
            servidor: bundlesReais.servidor,
            hook: Buffer.concat([bundlesReais.hook, Buffer.from('\n// x\n')]),
          },
          executarHook: () => ({ status: 0 }),
          verificarServidor: verificarServidorFalso,
        }),
      ).rejects.toThrow();
      expect(fs.readFileSync(path.join(instalada.dirVersao, 'guarda-bash.mjs'))).toEqual(hookAntes);
      expect(fs.readdirSync(path.join(home, '.local', 'lib', 'hexlog'))).toEqual(['0.1.0']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(g) artefato instalado alterado por fora é reparado na execução seguinte', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-instalacao-g-'));
    try {
      const args = {
        home,
        versao: '0.1.0',
        bundles: bundlesReais,
        commit: null,
        sujo: false,
        agora: () => new Date(),
        executarHook: executarHookReaisDeInstalacao,
        verificarServidor: verificarServidorFalso,
        log: () => {},
      };
      const primeira = await instalarArtefato(args);
      const arquivoHookInstalado = path.join(primeira.dirVersao, 'guarda-bash.mjs');
      fs.writeFileSync(
        arquivoHookInstalado,
        Buffer.concat([bundlesReais.hook, Buffer.from('\n// alterado por fora\n')]),
      );

      const segunda = await instalarArtefato(args);
      expect(segunda.acao).toBe('reparado');
      expect(segunda.avisos).toEqual(
        expect.arrayContaining([expect.stringContaining('artefato instalado alterado')]),
      );
      expect(fs.readFileSync(arquivoHookInstalado)).toEqual(bundlesReais.hook);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(h) instaladores concorrentes: mesmo build convergem, builds diferentes só um vence', async () => {
    const homeIgual = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-concorrencia-igual-'));
    try {
      const [r1, r2] = await Promise.all([
        executarFixtureConcorrente(homeIgual, '0.1.0', 'x', 1, 2),
        executarFixtureConcorrente(homeIgual, '0.1.0', 'x', 2, 2),
      ]);
      expect([r1.status, r2.status]).toEqual([0, 0]);
      expect(fs.readdirSync(dirVersaoDe(homeIgual, '0.1.0')).sort()).toEqual([
        'guarda-bash.mjs',
        'manifesto.json',
        'servidor.mjs',
      ]);
    } finally {
      fs.rmSync(homeIgual, { recursive: true, force: true });
    }

    const homeDiferente = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-concorrencia-diferente-'));
    try {
      const [r1, r2] = await Promise.all([
        executarFixtureConcorrente(homeDiferente, '0.1.0', 'x', 1, 2),
        executarFixtureConcorrente(homeDiferente, '0.1.0', 'y', 2, 2),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([0, 1]);
      const perdedor = r1.status === 1 ? r1 : r2;
      expect(perdedor.stdout).toContain('ao mesmo tempo');
      expect(fs.readdirSync(dirVersaoDe(homeDiferente, '0.1.0')).sort()).toEqual([
        'guarda-bash.mjs',
        'manifesto.json',
        'servidor.mjs',
      ]);
    } finally {
      fs.rmSync(homeDiferente, { recursive: true, force: true });
    }
  }, 20_000);

  test('(h2) reinstalação concorrente: ENOENT no primeiro renameSync é tratado como concorrência, sem diretório misto', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-concorrencia-reinstalacao-'));
    try {
      // versão já instalada antes da corrida: o primeiro renameSync de cada
      // filho (dirVersao → antiga) só pode achar ENOENT se o outro já a moveu.
      await instalarArtefato({
        home,
        versao: '0.1.0',
        bundles: { servidor: Buffer.from('servidor-inicial'), hook: Buffer.from('hook-inicial') },
        commit: null,
        sujo: false,
        agora: () => new Date(),
        executarHook: (_arquivoHook, stdin) => ({ status: stdin.includes('/sonda') ? 2 : 0 }),
        verificarServidor: () => Promise.resolve(10),
        log: () => {},
      });

      const [r1, r2] = await Promise.all([
        executarFixtureConcorrente(home, '0.1.0', 'novo', 1, 2),
        executarFixtureConcorrente(home, '0.1.0', 'novo', 2, 2),
      ]);

      expect([r1.status, r2.status]).toEqual([0, 0]);
      const dirVersao = dirVersaoDe(home, '0.1.0');
      expect(fs.readdirSync(dirVersao).sort()).toEqual([
        'guarda-bash.mjs',
        'manifesto.json',
        'servidor.mjs',
      ]);
      expect(fs.readFileSync(path.join(dirVersao, 'servidor.mjs'), 'utf8')).toBe('servidor-novo');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('B3: instalar.ts --check (processo real)', () => {
  let home: string;
  let versao: string;

  beforeAll(() => {
    versao = (
      JSON.parse(fs.readFileSync(path.join(raizDoRepo, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-b3-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), montarSettingsTemplate(home));

    const instalacao = spawnSync(process.execPath, [path.join(raizDoRepo, 'scripts/instalar.ts')], {
      cwd: raizDoRepo,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        HEXLOG_REGISTRAR_MCP: path.join(raizDoRepo, 'test/fixtures/instalar-mcp-falso.ts'),
      },
    });
    if (instalacao.status !== 0) {
      throw new Error(
        `instalação real de baseline (B3) falhou: ${instalacao.stderr}\n${instalacao.stdout}`,
      );
    }
  }, 30_000);

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function rodarCheck(opts: { cwd?: string } = {}): { status: number | null; stdout: string } {
    const resultado = spawnSync(
      process.execPath,
      [path.join(raizDoRepo, 'scripts/instalar.ts'), '--check'],
      {
        cwd: opts.cwd ?? raizDoRepo,
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      },
    );
    return { status: resultado.status, stdout: resultado.stdout };
  }

  test('instalação completa: exit 0, sem artefato-alterado nem artefato-desatualizado', () => {
    const { status, stdout } = rodarCheck();
    expect(status).toBe(0);
    expect(stdout).not.toContain('artefato-alterado');
    expect(stdout).not.toContain('artefato-desatualizado');
  }, 15_000);

  test('diretório da versão removido: hook-arquivo, exit 1', () => {
    const dirVersao = dirVersaoDe(home, versao);
    const backup = `${dirVersao}.backup-teste`;
    fs.renameSync(dirVersao, backup);
    try {
      const { status, stdout } = rodarCheck();
      expect(status).toBe(1);
      expect(stdout).toContain('hook-arquivo');
    } finally {
      fs.renameSync(backup, dirVersao);
    }
  }, 15_000);

  test('guarda-bash.mjs instalado editado, mas ainda nega/permite: artefato-alterado, exit 1', () => {
    const arquivoHook = path.join(dirVersaoDe(home, versao), 'guarda-bash.mjs');
    const original = fs.readFileSync(arquivoHook);
    fs.writeFileSync(
      arquivoHook,
      Buffer.concat([original, Buffer.from('\n// comentário extra\n')]),
    );
    try {
      const { status, stdout } = rodarCheck();
      expect(status).toBe(1);
      expect(stdout).toContain('artefato-alterado');
    } finally {
      fs.writeFileSync(arquivoHook, original);
    }
  }, 15_000);

  test('quarta regra de deny ausente: deny-edit-lib, exit 1', () => {
    const caminhoSettings = path.join(home, '.claude', 'settings.json');
    const original = fs.readFileSync(caminhoSettings, 'utf8');
    const dados = parseJson(esquemaSettings, original);
    const D = path.join(home, '.local', 'share', 'hexlog');
    const esperado = regrasEsperadas(D, home, process.execPath, versao);
    dados.permissions.deny = dados.permissions.deny.filter(
      (r: string) => r !== esperado.denyEditLib,
    );
    fs.writeFileSync(caminhoSettings, JSON.stringify(dados));
    try {
      const { status, stdout } = rodarCheck();
      expect(status).toBe(1);
      expect(stdout).toContain('deny-edit-lib');
    } finally {
      fs.writeFileSync(caminhoSettings, original);
    }
  }, 15_000);

  test('build atual diferente do manifesto com bytes instalados íntegros: aviso artefato-desatualizado, exit inalterado', () => {
    // Chamada direta (sem subprocesso): `executarHookReal` herda `process.env` do
    // processo de teste, então o hook precisa enxergar o mesmo HOME temporário
    // usado pra montar `esperado` — mesmo motivo do describe I7.
    const homeOriginal = process.env.HOME;
    const xdgOriginal = process.env.XDG_DATA_HOME;
    process.env.HOME = home;
    delete process.env.XDG_DATA_HOME;
    try {
      const dirVersao = dirVersaoDe(home, versao);
      const manifesto = lerManifesto(dirVersao)!;
      const D = path.join(home, '.local', 'share', 'hexlog');
      const esperado = regrasEsperadas(D, home, process.execPath, versao);
      const textoSettings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
      const textoClaudeJson = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
      // Simula um build atual diferente do que gerou o manifesto, sem alterar a working tree real.
      const bundlesSimulandoBuildNovo: Bundles = {
        servidor: Buffer.from('servidor-de-um-build-futuro'),
        hook: fs.readFileSync(esperado.hookArquivo),
      };

      const resultado = verificarInstalacao({
        home,
        versao,
        execPath: process.execPath,
        D,
        bundlesAtuais: bundlesSimulandoBuildNovo,
        textoSettings,
        textoClaudeJson,
        executarHook: executarHookReal,
        headAtual: 'head-simulado-de-teste',
      });

      expect(resultado.exit).toBe(0);
      expect(resultado.avisos.some((a) => a.startsWith('artefato-desatualizado'))).toBe(true);
      expect(resultado.avisos.some((a) => a.includes(String(manifesto.commit)))).toBe(true);
      expect(resultado.avisos.some((a) => a.includes('head-simulado-de-teste'))).toBe(true);
    } finally {
      process.env.HOME = homeOriginal;
      if (xdgOriginal === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = xdgOriginal;
      }
    }
  });

  test('mesmo resultado rodando o --check de outro cwd', () => {
    const doRepo = rodarCheck();
    const deOutroCwd = rodarCheck({ cwd: os.tmpdir() });
    expect(deOutroCwd.status).toBe(doRepo.status);
    expect(deOutroCwd.stdout).toBe(doRepo.stdout);
  }, 15_000);
});
