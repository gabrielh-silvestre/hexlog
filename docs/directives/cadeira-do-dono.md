# Cadeira do dono

Regras da cadeira do dono: quem responde a lacuna no lugar do humano, com que modelo e como registra. Valem para a sessão principal e para todo subagente deste repositório.

## Exceção de modelo

- O `critic` durável lançado pela cadeira do dono no `flow-run`, inclusive nas sondas, roda em `opus`; é um só por trabalho, vive até o fim dele e é continuado por `SendMessage`.
- O `critic` não recebe `TaskStop` ao chegar a notificação, só no fim do trabalho; os subagentes e jurados dele seguem em `sonnet` ou `haiku` e nascem e morrem por pergunta.
- Exceção autorizada pelo dono ao CLAUDE.md global (Subagents: sonnet/haiku); vale só neste repositório.
