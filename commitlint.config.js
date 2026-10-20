// Mensagem de commit: Conventional Commits, header até 80 caracteres e sem corpo (humano e agente).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 80],
    'body-empty': [2, 'always'],
  },
  // Commit do Dependabot traz corpo e rodapé fora da regra; o `Signed-off-by` do bot é o que o
  // identifica, em PR de version update e de security update. Forjável: freio, não barreira.
  ignores: [
    /** @param {string} message */
    (message) => /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/m.test(message),
  ],
};
