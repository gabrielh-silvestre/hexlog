// Corpo do GitHub Release: abertura, subseções da versão no CHANGELOG.md e bloco de instalação.
// Só builtins e nenhum import de `src/`: o workflow `release.yml` roda sem `npm ci`.

export type ReleasePr = { readonly number: number; readonly url: string };

const INSTALL_BLOCK = `## Instalação

\`\`\`sh
node scripts/install.ts
node scripts/install.ts --check
\`\`\`

Reinicie o Claude Code depois. Detalhes em [README](https://github.com/gabrielh-silvestre/hexlog#readme) e \`docs/\`.`;

/** Corpo da seção `## [version]`, até o próximo `## ` ou o fim; lança se a seção falta ou está vazia. */
function versionSection(changelog: string, version: string): string {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (body === '') throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return body;
}

/** Os `###` da seção viram `##` no Release; linhas dentro de cerca de código passam intactas. */
function demoteHeadings(text: string): string {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) fenced = !fenced;
      return !fenced && line.startsWith('### ') ? line.slice(1) : line;
    })
    .join('\n');
}

/**
 * Monta o corpo do Release: parágrafo de abertura da seção (texto antes do 1º `###`), a linha do PR
 * da release (se houver) e as subseções; o bloco de instalação fecha.
 */
export function releaseNotes(changelog: string, version: string, pr?: ReleasePr): string {
  const section = versionSection(changelog, version);
  const firstHeading = section.search(/^### /m);
  const intro = (firstHeading === -1 ? section : section.slice(0, firstHeading)).trim();
  const subsections = firstHeading === -1 ? '' : demoteHeadings(section.slice(firstHeading)).trim();
  const prLine = pr === undefined ? '' : `PR da release: [#${pr.number}](${pr.url})`;
  const blocks = [intro, prLine, subsections, INSTALL_BLOCK].filter((block) => block !== '');
  return `${blocks.join('\n\n')}\n`;
}
