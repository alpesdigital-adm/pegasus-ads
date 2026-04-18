# GitHub Actions — Pegasus Ads

## `ci.yml`

Roda em todo PR + push em `main`. Três jobs paralelos:

| Job | Comando | O que pega |
|---|---|---|
| `lint` | `npm run lint` | eslint (regras do `eslint-config-next`) |
| `typecheck` | `npx tsc --noEmit` | erros de tipo TS |
| `build` | `npm run build` | erros de build do Next (module resolution, import circular, etc) |

Node 22, cache `npm`, Ubuntu. `concurrency` cancela runs obsoletos quando
novo commit chega no mesmo branch — evita fila longa.

## Env vars no `build`

O build do Next resolve todos os imports em `.next/standalone` e pode
executar código em module-init. Variáveis como `DATABASE_URL` precisam
estar **definidas** (não conectam em tempo de build — só são lidas por
`process.env.X`). Os valores fake no workflow são suficientes.

Se aparecer `Error: X is required` durante build na CI, adiciona a env
no job `build` (dummy value basta, não persistir segredos reais no
workflow).

## Adicionar deploy (Fase 5+)

Quando formos automatizar o deploy pra VPS, adiciona um job `deploy`
depende de lint/typecheck/build:

```yaml
deploy:
  needs: [lint, typecheck, build]
  if: github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: SSH deploy
      uses: appleboy/ssh-action@v1
      with:
        host: ${{ secrets.VPS_HOST }}
        username: root
        key: ${{ secrets.VPS_SSH_KEY }}
        script: |
          cd /apps/pegasus
          git pull
          bash scripts/cutover/01-deploy-green.sh
```

Segredos (`VPS_HOST`, `VPS_SSH_KEY`) vão em `Settings → Secrets and variables → Actions`.

## Sobre o check "Vercel" em PRs (TD-001)

Esse check sumiu após 2026-04-18 (Leandro removeu o projeto pegasus-ads
do Vercel). Se reaparecer, é porque a GitHub App continua instalada na
org por causa do `grclub` — desinstalar no repo ou apenas ignorar.
