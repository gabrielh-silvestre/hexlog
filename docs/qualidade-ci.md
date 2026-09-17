# Plataformas de qualidade para CI/CD

Estudo para quando o hexlog virar repositório público no GitHub. **Nada daqui
está instalado.** O CI atual (`.github/workflows/ci.yml`) roda só `typecheck`,
`lint`, `format:check` e `test`.

Fontes consultadas em **2026-09-17**. Preço e plano mudam; reconfira a fonte
antes de adotar qualquer item.

## Agora

Nativo do GitHub ou já vem com o npm. Custo zero para repo público, sem conta
externa.

| Ferramenta | Grátis p/ público | O que exige | Esforço | Valor para o hexlog | Fonte |
|---|---|---|---|---|---|
| CodeQL (default setup) | Sim | Settings → Code security → CodeQL → Default | ~5 min; minutos de Actions são grátis em repo público | SAST de TS/Node sem manutenção | [default setup](https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning), [billing GHAS](https://docs.github.com/en/billing/concepts/product-billing/github-advanced-security) |
| Dependabot (alerts, security updates, version updates) | Sim, e não consome minutos de Actions em repo público | Toggle em Settings; version updates pedem `.github/dependabot.yml` | ~10 min | PR automático para dependência vulnerável ou desatualizada | [alerts](https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts), [security updates](https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates), [version updates](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/about-dependabot-version-updates) |
| npm audit | Sim, vem com o npm | Um step `npm audit --audit-level=high` no CI | ~5 min | Gate síncrono no PR; sobrepõe o Dependabot | [npm audit](https://docs.npmjs.com/cli/v10/commands/npm-audit) |

## Depois

Valor real, mas pede conta SaaS, token, cobertura gerada ou regra para manter.
Adotar um por vez, cada um no próprio PR, quando o repo tiver tração.

| Ferramenta | Grátis p/ público | O que exige | Esforço | Valor para o hexlog | Fonte |
|---|---|---|---|---|---|
| SonarQube Cloud | Sim, plano OSS sem limite de LOC para público (o "Free" de 50k LOC é o de privado) | Conta + GitHub App + step no CI | ~20–30 min | Smells, duplicação, hotspots e quality gate no PR; cobre o que o CodeQL não cobre | [planos](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans), [preços](https://www.sonarsource.com/plans-and-pricing/sonarcloud/) |
| Codecov | Sim, uploads ilimitados em repo público | Conta + GitHub App + upload de cobertura (hoje o CI não gera cobertura) | ~15 min | Diff de cobertura comentado no PR | [preços](https://about.codecov.io/pricing/) |
| knip | Sim (ISC, CLI local) | `npm i -D knip` + config | ~15–30 min para calibrar ignores | Arquivo, export e dependência sem uso | [knip.dev](https://knip.dev/) |
| dependency-cruiser | Sim (MIT, CLI local) | `npm i -D dependency-cruiser` + `.dependency-cruiser.js` | ~30–60 min para escrever regras úteis | Barra ciclo e import entre camadas | [repo](https://github.com/sverweij/dependency-cruiser) |
| Semgrep CE | Sim; a CLI (LGPL-2.1) com regras da comunidade não pede conta nem tem limite. O limite de 10 repos/10 contribuidores é da plataforma cloud, opcional | Job no CI com `semgrep` e ruleset da comunidade | ~15–20 min | Segundo motor de SAST, com cobertura de regra diferente da do CodeQL | [Community Edition](https://semgrep.dev/products/community-edition/), [preços](https://semgrep.dev/pricing/) |

Opengrep ([repo](https://github.com/opengrep/opengrep)) é o fork LGPL-2.1 do
motor do Semgrep mantido por um consórcio. Serve de plano B se o licenciamento
do Semgrep mudar; rodar os dois é redundante.

## Nunca

| Ferramenta | Motivo | Fonte |
|---|---|---|
| SonarQube Server Community Build | Infra própria (servidor Java + Postgres) para manter, e só analisa a branch principal: PR decoration só na Developer Edition, paga. O SonarQube Cloud OSS entrega mais sem custo | [download](https://www.sonarsource.com/products/sonarqube/downloads/), [PR analysis](https://docs.sonarsource.com/sonarqube-server/latest/analyzing-source-code/pull-request-analysis/introduction/) |
| Codacy | Plano Open Source existe, mas cobre o mesmo nicho do SonarQube Cloud | [preços](https://www.codacy.com/pricing) |
| DeepSource | Plano Open Source com teto de 1.000 PR reviews/mês; o diferencial (autofix com IA) é pago por crédito | [preços](https://deepsource.com/pricing) |
| Qlty | Plano Free limitado por minutos de análise, sem número publicado na página; mesmo nicho do SonarQube Cloud | [preços](https://qlty.sh/pricing) |

## Ordem sugerida quando o repo for público

1. Ligar CodeQL default setup e Dependabot alerts/security updates em Settings.
2. Adicionar `.github/dependabot.yml` para `npm` e `github-actions`.
3. Reavaliar a camada **Depois** quando a base crescer a ponto de duplicação e
   cobertura virarem sinal útil.
