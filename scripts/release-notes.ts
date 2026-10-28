// Corpo do GitHub Release: abertura, subseções da versão no CHANGELOG.md e bloco de instalação.
// Só builtins e nenhum import de `src/`: o workflow `release.yml` roda sem `npm ci`.

export type ReleasePr = { readonly number: number; readonly url: string };

const INSTALL_BLOCK = `## Instalação

\`\`\`sh
node scripts/install.ts
node scripts/install.ts --check
\`\`\`

Reinicie o Claude Code depois. Detalhes em [README](https://github.com/gabrielh-silvestre/hexlog#readme) e \`docs/\`.`;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Para cada linha, se ela está fora de cerca de código pela regra do CommonMark: abertura com até 3
 * espaços e 3 ou mais crases ou til (a info de cerca de crases não leva crase), fecho do mesmo
 * caractere, de tamanho igual ou maior e só com espaço depois; cerca sem fecho vai até o fim.
 * ponytail: cerca recuada em 4 ou mais espaços (dentro de item de lista) conta como código indentado;
 * a CHANGELOG não a usa, trate o contêiner se passar a usar.
 */
function outsideFences(lines: readonly string[]): boolean[] {
  let closing: RegExp | undefined;
  return lines.map((line) => {
    if (closing !== undefined) {
      if (closing.test(line)) closing = undefined;
      return false;
    }
    const [, marker = '', info = ''] = FENCE_OPEN.exec(line) ?? [];
    if (marker === '' || (marker.startsWith('`') && info.includes('`'))) return true;
    closing = new RegExp(`^ {0,3}${marker.charAt(0)}{${marker.length},}[ \\t]*$`);
    return false;
  });
}

/** Corpo da seção `## [version]`, até o próximo `## ` fora de cerca; lança se a seção falta ou está vazia. */
function versionSection(changelog: string, version: string): string {
  const lines = changelog.split('\n');
  const outside = outsideFences(lines);
  const isH2 = (index: number) =>
    outside[index] === true && lines[index]?.startsWith('## ') === true;
  const start = lines.findIndex((line, index) => isH2(index) && line.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((_line, index) => isH2(start + 1 + index));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (body === '') throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return body;
}

/**
 * Monta o corpo do Release: parágrafo de abertura da seção (texto antes do 1º `###`), a linha do PR
 * da release (se houver) e as subseções, com os `###` fora de cerca rebaixados a `##`; o bloco de
 * instalação fecha.
 * ponytail: `####` não é rebaixado, e o CHANGELOG não tem nenhum; o rodapé de links `[x.y.z]: url`
 * do CHANGELOG cairia no corpo da última seção (`## [1.0.0]`) e só importa se ela for pedida.
 */
export function releaseNotes(changelog: string, version: string, pr?: ReleasePr): string {
  const lines = versionSection(changelog, version).split('\n');
  const outside = outsideFences(lines);
  const isSubsectionHeading = lines.map(
    (line, index) => outside[index] === true && line.startsWith('### '),
  );
  const firstHeading = isSubsectionHeading.indexOf(true);
  const intro = (firstHeading === -1 ? lines : lines.slice(0, firstHeading)).join('\n').trim();
  const subsections =
    firstHeading === -1
      ? ''
      : lines
          .slice(firstHeading)
          .map((line, index) =>
            isSubsectionHeading[firstHeading + index] === true ? line.slice(1) : line,
          )
          .join('\n')
          .trim();
  const prLine = pr === undefined ? '' : `PR da release: [#${pr.number}](${pr.url})`;
  const blocks = [intro, prLine, subsections, INSTALL_BLOCK].filter((block) => block !== '');
  return `${blocks.join('\n\n')}\n`;
}
