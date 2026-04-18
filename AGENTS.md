<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:engineering-mantra -->
# Mantra de engenharia — Casa de tijolos, nunca casinha de palha

Construção sólida sempre. Não fazemos dívida técnica pra pagar depois.
Quando houver dúvida entre atalho vs. fundação direito, a escolha é
**sempre** a mais sólida, segura, estável e escalável. Fundação direito
antes do telhado. Se a solução parece frágil ou "pra resolver depois",
pare e redesenhe — o custo de retrabalho é sempre maior que o de fazer
certo agora.

Sinais de casinha de palha a rejeitar:
- "Depois a gente ajusta" (débito implícito)
- Feature flag pra esconder meia-implementação
- Workaround que assume invariante não-documentada
- Validação só no "happy path"
- Schema que não cabe o próximo requisito óbvio
- Cópia de código ao invés de abstração quando há 3+ usos idênticos

Quando fizer trade-off consciente, **documentar** (tech-debt.md + Brain)
com o racional, não varrer pra baixo do tapete.
<!-- END:engineering-mantra -->
