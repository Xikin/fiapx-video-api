# ADR-0007: Qualidade e segurança como gates do CI

**Status:** Aceita

## Contexto

O hackathon avalia qualidade de software. Na Fase 4 a esteira já tinha testes, cobertura e
SonarQube. Aqui entram também verificações de segurança, porque o sistema recebe arquivos de
usuários.

## Decisão

Todo PR passa por (`.github/workflows/ci.yml` e `codeql.yml`):

| Verificação       | Ferramenta                                       | Falha o PR quando                                |
| ----------------- | ------------------------------------------------ | ------------------------------------------------ |
| Formatação e lint | Prettier, ESLint (typescript-eslint)             | Há divergência ou erro                           |
| Tipos             | TypeScript `strict` + `noUncheckedIndexedAccess` | Há erro de tipo                                  |
| Testes            | Vitest: unitários, HTTP e Testcontainers         | Um teste falha ou a cobertura fica abaixo de 80% |
| Contrato da API   | `docs/openapi.json` exportado do código          | O arquivo versionado está desatualizado          |
| Qualidade         | SonarQube Cloud                                  | O quality gate reprova                           |
| SAST              | CodeQL (`security-and-quality`)                  | Há alerta novo                                   |
| Dependências      | `npm audit --omit=dev`                           | Há vulnerabilidade alta ou crítica               |
| Segredos          | gitleaks                                         | Há segredo no histórico                          |
| Dockerfile        | hadolint                                         | Há violação de boa prática                       |
| Imagem            | Trivy                                            | Há vulnerabilidade alta ou crítica com correção  |

Actions fixadas por SHA e atualizadas pelo Dependabot.

## Consequências

- O SonarQube é pulado com aviso enquanto o `SONAR_TOKEN` não estiver cadastrado no repositório.
- Uma vulnerabilidade nova numa dependência pode travar PRs sem relação com ela; a correção vem
  pelo PR do Dependabot.
