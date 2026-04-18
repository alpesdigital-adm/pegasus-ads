# TD-014 — DATABASE_URL demo no container Supavisor

Credencial que o Supavisor usa pra acessar o próprio metadata DB
(`_supabase` database, onde ficam `_supavisor.tenants` e
`_supavisor.users`) está em valor demo. Rede privada limita exposição,
mas qualquer container na docker network `alpes-ads_supabase_default`
ganha admin-level sobre o metadata.

## Estratégia (decidida após 01-inspect)

### Se user ≠ postgres/supabase_admin (CASO A)

Rotação simples de senha + restart. Zero coordenação com CRM.
→ TODO: criar `02-rotate.sh` (script ainda não escrito — confirmar caso
primeiro no inspect).

### Se user É postgres/supabase_admin (CASO B — provável)

**NÃO rotacionar superuser direto** — quebra CRM, Studio, Realtime,
Auth. Isolar via user dedicado:

1. `CREATE ROLE supavisor_meta` com permissões só em `_supabase`
2. Migrar Supavisor pra usar essa role (atualiza `DATABASE_URL`)
3. Supavisor restart (~5-10s, só pooling do pegasus-ads afetado)
4. Superuser original continua funcionando pros outros apps
5. Rotação do superuser vira outra janela separada coordenada com CRM
   (ou pode não ser necessária nunca — depende do modelo de ameaça)

→ `02-isolate-user.sh` cobre esse path.

## Scripts

| Script | O que faz | Lado |
|---|---|---|
| `01-inspect.sh` | Descobre user+blast radius, zero mudança | seguro rodar sempre |
| `02-isolate-user.sh` | Cria role `supavisor_meta`, permissões, valida conexão | precisa recreate manual do container depois |

## Execução

```bash
# 1. Inspeção
bash scripts/td-014-supavisor-dburl/01-inspect.sh

# 2. Se CASO B (user superuser): isolar
bash scripts/td-014-supavisor-dburl/02-isolate-user.sh

# 3. Recreate do container Supavisor (manual — script mostra instruções)
```

## Rollback

`02-isolate-user.sh` não modifica o container Supavisor — só cria role
nova no Postgres. Recreate do container é passo separado e manual.
Rollback = revert da env DATABASE_URL no compose + force-recreate.
Role `supavisor_meta` fica criada mas sem uso (benign).

## Coordenação com CRM

Se cair no CASO B e decidir **também** rotacionar senha do
`postgres`/`supabase_admin` depois (hardening completo):

- Avisar cowork CRM com pelo menos 24h
- Listar todos containers que usam esses users (Studio, Realtime, Auth,
  Storage, pegasus-crm app, etc)
- Janela de manutenção coordenada (~15min pra rotação + validação)
- Este repo cobre só a parte do Supavisor. CRM faz os demais containers.
