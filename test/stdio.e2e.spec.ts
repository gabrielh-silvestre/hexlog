// e2e do passo 8: fala stdio contra o bundle real (`servidor.mjs`), nunca contra `src/*.ts`
// (§9.3, U-7). O `.ts` já é coberto em processo por `InMemoryTransport` nos passos 7a/7b/7c;
// aqui o alvo é o caminho de produção — o que as sessões realmente executam.
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isUndefined, omitBy } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { dirDados } from '../src/directory.ts';
import type { Registro } from '../src/log.ts';

const raizDoRepo = path.resolve(__dirname, '..');
const caminhoDoBuild = path.join(raizDoRepo, 'scripts/build.ts');

// ---- infra compartilhada ----

const diretoriosTemporarios: string[] = [];

function mkdtempFora(prefixo: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  diretoriosTemporarios.push(dir);
  return dir;
}

/** `env` de um processo filho isolado: HOME e XDG_DATA_HOME temporários (§9.3); o real nunca é tocado. */
function envTemporario(): Record<string, string> {
  const base = omitBy(process.env, isUndefined) as Record<string, string>;
  return {
    ...base,
    HOME: mkdtempFora('hexlog-e2e-home-'),
    XDG_DATA_HOME: mkdtempFora('hexlog-e2e-xdg-'),
  };
}

function construirBundle(outdir: string, cwd: string): void {
  const resultado = spawnSync(process.execPath, [caminhoDoBuild, '--outdir', outdir], {
    cwd,
    encoding: 'utf8',
  });
  if (resultado.status !== 0) {
    throw new Error(`build de e2e falhou (cwd=${cwd}): ${resultado.stderr}`);
  }
}

function sha256Arquivo(caminho: string): string {
  return createHash('sha256').update(fs.readFileSync(caminho)).digest('hex');
}

/** Acumula os `data` de um stream (stdout/stderr de processo filho ou de `StdioClientTransport`) em texto. */
function coletorDeLinhas(fonte: NodeJS.EventEmitter | null) {
  const estado = { texto: '' };
  fonte?.on('data', (chunk: Buffer) => {
    estado.texto += chunk.toString();
  });
  return {
    linhas: () => estado.texto.split('\n').filter((linha) => !isEmpty(linha)),
    texto: () => estado.texto,
  };
}

/** Parseia cada linha do stderr estruturado (§4.15) como um `Registro`. */
function registrosDeStderr(texto: string): Registro[] {
  return texto
    .split('\n')
    .filter((linha) => !isEmpty(linha))
    .map((linha) => JSON.parse(linha) as Registro);
}

function aguardar(condicao: () => boolean, intervaloMs = 20): Promise<void> {
  return new Promise((resolve) => {
    const verificar = () => (condicao() ? resolve() : setTimeout(verificar, intervaloMs));
    verificar();
  });
}

async function criarCliente(servidorMjs: string, env: Record<string, string>, cwd: string) {
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: [servidorMjs],
    env,
    cwd,
    stderr: 'pipe',
  });
  const stderr = coletorDeLinhas(transporte.stderr);
  const cliente = new Client({ name: 'hexlog-e2e', version: '0.0.0' });
  await cliente.connect(transporte);
  return { cliente, stderr };
}

// ---- diretório de dados real: nunca tocado por estes e2e ----

let dirRealAntes: { existe: boolean; mtimeMs?: number };

beforeAll(() => {
  const dirReal = dirDados(process.env);
  dirRealAntes = fs.existsSync(dirReal)
    ? { existe: true, mtimeMs: fs.statSync(dirReal).mtimeMs }
    : { existe: false };
});

afterAll(() => {
  const dirReal = dirDados(process.env);
  expect(fs.existsSync(dirReal)).toBe(dirRealAntes.existe);
  if (dirRealAntes.existe) {
    expect(fs.statSync(dirReal).mtimeMs).toBe(dirRealAntes.mtimeMs);
  }
  for (const dir of diretoriosTemporarios) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bundle principal: compartilhado por M6, B1(a), B1(c) e C1 ----

let bundlePrincipal: string;

beforeAll(() => {
  bundlePrincipal = mkdtempFora('hexlog-e2e-bundle-');
  construirBundle(bundlePrincipal, raizDoRepo);
}, 30_000);

describe('M6', () => {
  test('bundle fala só JSON-RPC 2.0 no stdout e JSON estruturado (evento) no stderr', async () => {
    const filho = spawn(process.execPath, [path.join(bundlePrincipal, 'servidor.mjs')], {
      cwd: bundlePrincipal,
      env: envTemporario(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = coletorDeLinhas(filho.stdout);
    const stderr = coletorDeLinhas(filho.stderr);
    const enviar = (mensagem: unknown) => filho.stdin.write(`${JSON.stringify(mensagem)}\n`);

    enviar({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hexlog-e2e', version: '0.0.0' },
      },
    });
    await aguardar(() => stdout.linhas().length >= 1);

    enviar({ jsonrpc: '2.0', method: 'notifications/initialized' });
    enviar({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await aguardar(() => stdout.linhas().length >= 2);

    enviar({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'listar', arguments: {} },
    });
    await aguardar(() => stdout.linhas().length >= 3);

    // Erro de domínio: continua uma resposta JSON-RPC normal, com `result.isError`.
    enviar({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'cadeia', arguments: { projeto: 'fantasma', processo: 'fantasma' } },
    });
    await aguardar(() => stdout.linhas().length >= 4);

    const linhas = stdout.linhas();
    expect(linhas).toHaveLength(4);
    for (const linha of linhas) {
      const mensagem = JSON.parse(linha) as { jsonrpc: string; id?: unknown; method?: unknown };
      expect(mensagem.jsonrpc).toBe('2.0');
      expect(mensagem.id !== undefined || mensagem.method !== undefined).toBe(true);
    }
    expect((JSON.parse(linhas[3]) as { result: { isError?: boolean } }).result.isError).toBe(true);

    for (const registro of registrosDeStderr(stderr.texto())) {
      expect(registro.evento).toBeDefined();
    }

    filho.kill();
  }, 15_000);
});

describe('B1', () => {
  const ESPERA_BUSCA_MS = 20 * 60 * 1000;
  const INTERVALO_BUSCA_MS = 15_000;

  function commitFeatBuscaExiste(): boolean {
    const resultado = spawnSync('git', ['log', '--oneline'], { cwd: raizDoRepo, encoding: 'utf8' });
    return resultado.stdout.includes('feat(busca)');
  }

  /** Espera o commit `feat(busca)` de outro executor (poll a cada 15s, até 20 min). */
  async function esperarFeatBusca(): Promise<boolean> {
    const limite = Date.now() + ESPERA_BUSCA_MS;
    while (!commitFeatBuscaExiste() && Date.now() < limite) {
      await new Promise((resolve) => setTimeout(resolve, INTERVALO_BUSCA_MS));
    }
    return commitFeatBuscaExiste();
  }

  describe('(a)', () => {
    let buscaDisponivel = false;

    beforeAll(async () => {
      buscaDisponivel = await esperarFeatBusca();
    }, ESPERA_BUSCA_MS + 5_000);

    test('uma chamada de cada uma das 10 tools contra o bundle, sem erro, sem INTERNO, sem Dynamic require', async () => {
      const projeto = 'e2e-proj';
      const processo = 'e2e-proc';
      const { cliente, stderr } = await criarCliente(
        path.join(bundlePrincipal, 'servidor.mjs'),
        envTemporario(),
        bundlePrincipal,
      );

      try {
        const chamar = async (nome: string, args: Record<string, unknown> = {}) => {
          const resultado = (await cliente.callTool({ name: nome, arguments: args })) as {
            isError?: boolean;
          };
          expect(resultado.isError).not.toBe(true);
          return resultado;
        };

        await chamar('registrar_vocabulario', {
          projeto,
          dono: 'nucleo',
          marcoTipo: ['aprovado'],
          resultado: ['ok'],
          acao: ['seguir'],
        });
        await chamar('registrar_tipo', {
          projeto,
          nome: 'nota-e2e',
          schema: {
            type: 'object',
            properties: { quando: { type: 'string', format: 'date-time' } },
            required: ['quando'],
            additionalProperties: false,
          },
        });
        await chamar('registrar_gate', {
          projeto,
          nome: 'gate-e2e',
          criterio: 'critério e2e qualquer',
        });
        await chamar('criar_processo', { projeto, processo });
        await chamar('registrar', {
          projeto,
          processo,
          id: `${projeto}:${processo}:marco`,
          agente: 'agente-e2e',
          dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:e2e1' },
        });
        await chamar('registrar', {
          projeto,
          processo,
          id: `${projeto}:${processo}:veredito`,
          agente: 'agente-e2e',
          dados: {
            afirmacao: 'a',
            fonte: 'f',
            resultado: 'ok',
            prova: 'p',
            destino: 'hex:alvo:e2e1',
            origem: 'o',
            rastro: 'r',
          },
        });
        await chamar('registrar', {
          projeto,
          processo,
          id: `${projeto}:${processo}:nota-e2e`,
          agente: 'agente-e2e',
          dados: { quando: new Date().toISOString() },
        });
        await chamar('avaliar_gate', {
          projeto,
          processo,
          gate: 'sem-conflitos',
          agente: 'agente-e2e',
          alvo: 'hex:alvo:e2e1',
        });
        await chamar('estado', { projeto, processo });
        await chamar('eventos', { projeto, processo });
        if (buscaDisponivel) {
          await chamar('eventos', { projeto, processo, busca: 'aprovado' });
        }
        await chamar('cadeia', { projeto, processo });
        await chamar('listar', {});
      } finally {
        await cliente.close();
      }

      const textoStderr = stderr.texto();
      expect(textoStderr).not.toContain('"codigo":"INTERNO"');
      expect(textoStderr).not.toContain('Dynamic require');
    }, 20_000);
  });

  test('(c) servidor.mjs e guarda-bash.mjs não contêm o shim "Dynamic require of"', () => {
    for (const arquivo of ['servidor.mjs', 'guarda-bash.mjs']) {
      const texto = fs.readFileSync(path.join(bundlePrincipal, arquivo), 'utf8');
      expect(texto.includes('Dynamic require of')).toBe(false);
    }
  });

  describe('(d)', () => {
    let bundleDaRaiz: string;
    let bundleDoTmp: string;

    beforeAll(() => {
      bundleDaRaiz = mkdtempFora('hexlog-e2e-b1d-raiz-');
      bundleDoTmp = mkdtempFora('hexlog-e2e-b1d-tmp-');
      construirBundle(bundleDaRaiz, raizDoRepo);
      construirBundle(bundleDoTmp, os.tmpdir());
    }, 30_000);

    test('build com cwd na raiz e com cwd em os.tmpdir() geram sha256 idênticos', () => {
      for (const arquivo of ['servidor.mjs', 'guarda-bash.mjs']) {
        expect(sha256Arquivo(path.join(bundleDaRaiz, arquivo))).toBe(
          sha256Arquivo(path.join(bundleDoTmp, arquivo)),
        );
      }
    });
  });
});

describe('C1', () => {
  type EventoSemeado = { id: string; agente: string; dados: Record<string, unknown> };
  type RespostaRegistrar = {
    isError?: boolean;
    structuredContent?: { deduplicado: boolean; evento: { seq: number; id: string } };
  };

  /** 20 `registrar` com prefixo + 5 retentativas por id completo de elos semeados, todos em paralelo. */
  function dispararRodada(
    cliente: Client,
    projeto: string,
    processo: string,
    indiceServidor: number,
    semeados: EventoSemeado[],
  ) {
    const escritas = Array.from({ length: 20 }, (_, indice) =>
      cliente.callTool({
        name: 'registrar',
        arguments: {
          projeto,
          processo,
          id: `${projeto}:${processo}:marco`,
          agente: `servidor${indiceServidor}`,
          dados: { marcoTipo: 'aprovado', alvo: `hex:alvo:s${indiceServidor}-${indice}` },
        },
      }),
    );
    const retentativas = semeados.slice(0, 5).map((semente) =>
      cliente.callTool({
        name: 'registrar',
        arguments: {
          projeto,
          processo,
          id: semente.id,
          agente: semente.agente,
          dados: semente.dados,
        },
      }),
    );
    return Promise.all([...escritas, ...retentativas]) as Promise<RespostaRegistrar[]>;
  }

  test('4 servidores concorrentes, barreira por lock artificial: 100 linhas, seq 0..99, cadeia íntegra, 20 deduplicados, zero timeouts', async () => {
    const projeto = 'c1-proj';
    const processo = 'c1-proc';
    const env = envTemporario();
    const servidorMjs = path.join(bundlePrincipal, 'servidor.mjs');

    // 1) semeadura: um servidor à parte, fechado antes da concorrência começar.
    const semente = await criarCliente(servidorMjs, env, bundlePrincipal);
    await semente.cliente.callTool({
      name: 'registrar_vocabulario',
      arguments: { projeto, dono: 'nucleo', marcoTipo: ['aprovado'], resultado: [], acao: [] },
    });
    await semente.cliente.callTool({ name: 'criar_processo', arguments: { projeto, processo } });

    const semeados: EventoSemeado[] = [];
    for (let indice = 0; indice < 20; indice++) {
      const agente = 'semente';
      const dados = { marcoTipo: 'aprovado', alvo: `hex:alvo:seed${indice}` };
      const resultado = await semente.cliente.callTool({
        name: 'registrar',
        arguments: { projeto, processo, id: `${projeto}:${processo}:marco`, agente, dados },
      });
      const corpo = resultado.structuredContent as { evento: { id: string } };
      semeados.push({ id: corpo.evento.id, agente, dados });
    }
    await semente.cliente.close();

    // 2) lock artificial: qualquer `anexar` real colide já na primeira tentativa.
    const arquivoEventos = path.join(dirDados(env), projeto, processo, 'eventos.jsonl');
    const dirLock = `${arquivoEventos}.lock`;
    fs.mkdirSync(dirLock);
    fs.writeFileSync(path.join(dirLock, 'owner'), 'token-alheio');

    // 3) 4 servidores concorrentes, mesmo `env`.
    const clientes = await Promise.all(
      Array.from({ length: 4 }, () => criarCliente(servidorMjs, env, bundlePrincipal)),
    );
    const contarLockEspera = () =>
      clientes
        .flatMap((c) => registrosDeStderr(c.stderr.texto()))
        .filter((registro) => registro.evento === 'lock-espera').length;

    const inicioBarreira = Date.now();
    const disparos = clientes.map((cliente, indice) =>
      dispararRodada(cliente.cliente, projeto, processo, indice, semeados),
    );

    // A espera pela aquisição do lock em `adquirirLock` (src/log.ts) é assíncrona: o handler de
    // uma tool devolve o controle ao laço de mensagens do SDK entre uma tentativa e outra, então
    // as 20 chamadas de `registrar` com prefixo de cada um dos 4 servidores despacham e colidem
    // com o lock artificial, gerando as 80 `lock-espera` que o AC C1 exige antes da soltura.
    await aguardar(() => contarLockEspera() >= 80, 5);
    const msBarreira = Date.now() - inicioBarreira;
    fs.rmSync(dirLock, { recursive: true, force: true });

    const respostas = (await Promise.all(disparos)).flat();
    const cadeiaResultado = (
      await clientes[0].cliente.callTool({ name: 'cadeia', arguments: { projeto, processo } })
    ).structuredContent as {
      ok: boolean;
    };

    await Promise.all(clientes.map((c) => c.cliente.close()));

    // ---- verificações ----
    expect(msBarreira).toBeLessThan(3_000);
    expect(respostas.every((resposta) => resposta.isError !== true)).toBe(true);

    const linhasDoArquivo = fs
      .readFileSync(arquivoEventos, 'utf8')
      .split('\n')
      .filter((linha) => !isEmpty(linha));
    expect(linhasDoArquivo).toHaveLength(100);
    const elos = linhasDoArquivo.map((linha) => JSON.parse(linha) as { seq: number; id: string });
    expect(elos.map((elo) => elo.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, indice) => indice),
    );
    expect(new Set(elos.map((elo) => elo.id)).size).toBe(100);
    expect(cadeiaResultado.ok).toBe(true);

    const totalDeduplicados = respostas.filter(
      (resposta) => resposta.structuredContent?.deduplicado === true,
    ).length;
    expect(totalDeduplicados).toBe(20);

    const registrosTodos = clientes.flatMap((c) => registrosDeStderr(c.stderr.texto()));
    expect(registrosTodos.some((registro) => registro.evento === 'lock-orfao-removido')).toBe(
      false,
    );
    expect(registrosTodos.some((registro) => registro.codigo === 'LOCK_TIMEOUT')).toBe(false);
    expect(registrosTodos.some((registro) => registro.codigo === 'LOCK_PERDIDO')).toBe(false);

    const msDeRegistrar = registrosTodos
      .filter((registro) => registro.evento === 'tool' && registro.nome === 'registrar')
      .map((registro) => registro.ms as number);
    const totalLockEspera = registrosTodos.filter(
      (registro) => registro.evento === 'lock-espera',
    ).length;
    process.stdout.write(
      `C1: barreira=${msBarreira}ms maiorMsRegistrar=${Math.max(...msDeRegistrar)}ms totalLockEspera=${totalLockEspera} (min. garantido 80)\n`,
    );
  }, 60_000);
});
