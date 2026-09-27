"""Extrai sinais de atrito no uso de uma tool MCP a partir dos transcripts do Claude Code.

Uso:
    python3 mine.py --project-dir ~/.claude/projects/-home-gabriel-work \
        --from 2026-09-21 --to 2026-09-25 --out /caminho/scratch/mining [--tz-offset -03:00]

Saída em --out: calls.jsonl (todas as chamadas da janela, compactas), um JSONL por bucket
(a_error_<tool>, c_orient_<tool>, d_cost_<tool>, e_user) e stats.json. Imprime o stats.json.
"""
import argparse, collections, datetime, glob, json, os, re

# Para portar para outra tool MCP, troque estas três constantes (ver docs/friction-mining.md).
TOOL_PREFIX = 'mcp__hexlog__'
READS = {'events', 'state', 'list', 'chain'}
WRITES = {'register', 'evaluate_gate', 'create_process', 'register_gate', 'register_vocabulary', 'register_type'}

SERVER = TOOL_PREFIX.split('__')[1]
KEYWORD_RE = re.compile(re.escape(SERVER), re.I)
# role=user também carrega carga de skill, lembretes do harness e mensagens entre agentes.
USER_NOISE = ('Base directory for this skill:', '<teammate-message', '<cross-session-message', '<agent-message',
              '<system-reminder', '<command-message', '<task-notification', '<local-command', 'Caveat:')
CMD_RE = re.compile(r'<command-name>/?([^<]+)</command-name>')
ID_RE = re.compile(r'"id"\s*:\s*"([^"]{6,})"')
# Resultado grande demais: o Claude Code grava em arquivo e deixa só este aviso no transcript.
PERSISTED_RE = re.compile(r'result \(([\d,]+) characters\) exceeds maximum allowed tokens\. '
                          r'Output has been saved to (\S+?)\.?(?:\n|$)')
BIG = 10_000


def text_of(content):
    if isinstance(content, str):
        return content
    return ''.join(x.get('text', '') for x in content or [] if isinstance(x, dict))


def user_text(content):
    if isinstance(content, str):
        return content
    return ''.join(b.get('text', '') for b in content or [] if isinstance(b, dict) and b.get('type') == 'text')


def ids_of(path):
    if '/subagents/' in path:
        return os.path.basename(path)[:-6], path.split('/')[-3], True
    sid = os.path.basename(path)[:-6]
    return sid, sid, False


def parse_result(block):
    """Devolve (texto, tamanho real, persisted). Lê o arquivo salvo quando ainda existe."""
    txt = text_of(block.get('content'))
    m = PERSISTED_RE.search(txt)
    if not m:
        return txt, len(txt), False
    size = int(m.group(1).replace(',', ''))
    try:
        with open(m.group(2), errors='ignore') as f:
            return f.read(), size, True
    except OSError:
        return txt, size, True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-dir', required=True)
    ap.add_argument('--from', dest='lo', required=True, help='YYYY-MM-DD, inclusivo')
    ap.add_argument('--to', dest='to', required=True, help='YYYY-MM-DD, inclusivo')
    ap.add_argument('--out', required=True)
    ap.add_argument('--tz-offset', default='-03:00', help='fuso das datas da janela; o ts do transcript é UTC (padrão BRT)')
    a = ap.parse_args()
    root = os.path.expanduser(a.project_dir)
    # janela local convertida para UTC; comparação por string funciona com o ts ISO do transcript
    tz = datetime.datetime.strptime(a.tz_offset.replace(':', ''), '%z').tzinfo
    utc = lambda d: datetime.datetime.combine(d, datetime.time(), tz).astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    lo = utc(datetime.date.fromisoformat(a.lo))
    hi = utc(datetime.date.fromisoformat(a.to) + datetime.timedelta(days=1))
    os.makedirs(a.out, exist_ok=True)

    files = sorted(glob.glob(f'{root}/*.jsonl')) + sorted(glob.glob(f'{root}/*/subagents/*.jsonl'))
    seen_uuid = set()
    buckets = collections.defaultdict(list)
    stats = collections.Counter()
    all_calls = []

    for path in files:
        sid, parent, is_sub = ids_of(path)
        calls, pending = [], {}
        last_text, turn_skill, session_skill, first_prompt, user_asked = '', None, None, None, False
        for line in open(path, errors='ignore'):
            try:
                m = json.loads(line)
            except ValueError:
                continue
            u = m.get('uuid')
            if u:
                if u in seen_uuid:  # subagente fork repete o histórico da mãe
                    stats['dup_uuid_skipped'] += 1
                    continue
                seen_uuid.add(u)
            ts = m.get('timestamp', '')
            msg = m.get('message') or {}
            role = msg.get('role') or m.get('type')
            content = msg.get('content')
            if role == 'user' and not m.get('isMeta'):
                t = user_text(content)
                is_result = isinstance(content, list) and any(
                    isinstance(b, dict) and b.get('type') == 'tool_result' for b in content)
                if t and not is_result:
                    if first_prompt is None:
                        first_prompt = t
                    cmd = CMD_RE.search(t)
                    if cmd:  # slash command conta como mensagem real + skill do turno
                        turn_skill = session_skill = cmd.group(1).strip()
                        user_asked = False
                    elif not is_sub and not any(n in t[:200] for n in USER_NOISE):  # 1º prompt de subagente não é usuário
                        turn_skill, user_asked = None, bool(KEYWORD_RE.search(t))
                        if lo <= ts < hi and user_asked:
                            buckets['e_user'].append({'session': sid, 'parent': parent, 'ts': ts,
                                                      'prev_assistant': last_text[-600:], 'user': t[:1500]})
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'text' and role == 'assistant':
                    last_text = b.get('text', '')
                if b.get('type') == 'tool_use' and b.get('name') == 'Skill':
                    turn_skill = session_skill = (b.get('input') or {}).get('skill')
                if b.get('type') == 'tool_use' and b.get('name', '').startswith(TOOL_PREFIX):
                    # ponytail: origem de subagente pela menção no 1º prompt; cruzar com o spawn da mãe se precisar de precisão
                    if turn_skill:
                        origin = f'skill:{turn_skill}'
                    elif user_asked:
                        origin = 'user-asked'
                    elif is_sub:
                        origin = 'subagent-prompt' if first_prompt and KEYWORD_RE.search(first_prompt) else 'subagent-none'
                    elif session_skill:
                        origin = f'continuation:{session_skill}'
                    else:
                        origin = 'none'
                    c = {'session': sid, 'parent': parent, 'is_sub': is_sub, 'ts': ts,
                         'tool': b['name'][len(TOOL_PREFIX):], 'args': b.get('input') or {},
                         'before': last_text[-400:], 'origin': origin, 'result': None}
                    pending[b['id']] = c
                    if lo <= ts < hi:
                        calls.append(c)
                if b.get('type') == 'tool_result' and b.get('tool_use_id') in pending:
                    c = pending.pop(b['tool_use_id'])
                    txt, c['size'], c['persisted'] = parse_result(b)
                    c['is_error'] = bool(b.get('is_error'))
                    c['result'] = txt
                    try:
                        j = json.loads(txt)
                    except ValueError:
                        j = None
                    # erro só pelo JSON estruturado: regex no texto pega código de domínio gravado no payload
                    c['code'] = j.get('code') if isinstance(j, dict) and 'message' in j else None
                    ws = j.get('warnings') if isinstance(j, dict) else None
                    c['warn_kinds'] = dict(collections.Counter(
                        w.get('kind') for w in ws if isinstance(w, dict))) if isinstance(ws, list) else {}
                    c['ids'] = set(ID_RE.findall(txt))

        seen_ids, seen_args = set(), set()
        for i, c in enumerate(calls):
            stats[f'calls:{c["tool"]}'] += 1
            stats[f'origin:{c["origin"].split(":")[0]}'] += 1
            if c['result'] is None:
                continue
            a_ = c['args']
            key = (c['tool'], json.dumps(a_, sort_keys=True))
            proc, target = a_.get('process'), a_.get('target') or a_.get('targets')
            brief = {'session': c['session'], 'parent': c['parent'], 'ts': c['ts'], 'tool': c['tool'],
                     'args': json.dumps(a_, ensure_ascii=False)[:500], 'size': c['size'], 'origin': c['origin'],
                     'before': c['before']}
            all_calls.append({**brief, 'is_error': c['is_error'], 'code': c['code'], 'persisted': c['persisted'],
                              'warn_kinds': c['warn_kinds']})
            nxt = calls[i + 1:i + 4]
            if c['is_error'] or c['code']:  # (a) erro + (b) retry
                retry = [n for n in nxt if n['tool'] == c['tool'] and n['args'] != a_]
                buckets[f'a_error_{c["tool"]}'].append({
                    **brief, 'code': c['code'], 'result': c['result'][:800], 'retry': bool(retry),
                    'retry_ok': bool(retry and retry[0].get('result') is not None
                                     and not (retry[0]['is_error'] or retry[0]['code']))})
            if c['tool'] in READS:  # (c) orientação
                follows = [n for n in nxt if n['tool'] in WRITES]
                same = [n for n in follows if proc and n['args'].get('process') == proc]
                rep = [p for p in calls[:i] if p['tool'] == c['tool'] and p['args'].get('process') == proc
                       and (p['args'].get('target') or p['args'].get('targets')) == target]
                kind = 'legit' if same else ('repeat_no_write' if rep and not follows else 'other')
                stats[f'c_orient:{kind}'] += 1
                if kind == 'repeat_no_write':
                    buckets[f'c_orient_{c["tool"]}'].append({**brief, 'repeats_before': len(rep)})
            if c['size'] > BIG:  # (d) custo = grande E redundante
                stats[f'd_big:{c["tool"]}'] += 1
                reasons = []
                if c['persisted']:
                    reasons.append('persisted_output')
                if c['warn_kinds'].get('extension'):
                    reasons.append(f'extension_warnings={c["warn_kinds"]["extension"]}')
                if key in seen_args:
                    reasons.append('identical_call_earlier')
                if c['ids']:
                    ov = len(c['ids'] & seen_ids) / len(c['ids'])
                    if ov > 0.5:
                        reasons.append(f'ids_already_seen={ov:.0%}')
                if reasons:
                    buckets[f'd_cost_{c["tool"]}'].append({**brief, 'reasons': reasons, 'n_ids': len(c['ids']),
                                                          'result_head': c['result'][:600]})
            seen_args.add(key)
            seen_ids |= c['ids']

    def dump(name, rows):
        with open(os.path.join(a.out, f'{name}.jsonl'), 'w') as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')

    dump('calls', all_calls)
    for name, rows in buckets.items():
        dump(name, rows)
        stats[f'bucket:{name}'] = len(rows)
        stats[f'bucket_parents:{name}'] = len({r['parent'] for r in rows})
    stats['parents_with_calls'] = len({c['parent'] for c in all_calls})
    out = dict(sorted(stats.items()))
    with open(os.path.join(a.out, 'stats.json'), 'w') as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
