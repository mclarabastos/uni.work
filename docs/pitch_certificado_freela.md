# Pitch: Certificado — Trabalho que vira renda e vira histórico

**Track 01 — Vida Universitária**
**Roteiro para vídeo de até 5 minutos**

---

## Bloco 1 — O Problema (~1 min)

Sete em cada dez universitários de faculdade particular no Brasil trabalham enquanto estudam. Na rede pública, é mais da metade. Não é escolha — é sobrevivência acadêmica: é assim que a maioria consegue continuar pagando a faculdade ou se mantendo na cidade onde estuda.

Ao mesmo tempo, todo curso de graduação no Brasil exige entre 100 e 300 horas de atividade complementar — extensão, monitoria, estágio, participação em evento — como condição pra colar grau. É exigência do MEC.

O problema é que essas duas necessidades — ganhar dinheiro e cumprir hora curricular — são resolvidas hoje de formas separadas e frágeis:

- Quem faz freela físico (staff de evento, credenciamento, apoio de produção) enfrenta atraso e calote com frequência. Encontramos relatos reais no Reclame Aqui: freelancers que trabalharam a diária inteira e esperaram mais de dez dias por um pagamento de R$120, sem contrato, sem garantia, só mensagem de WhatsApp.
- O certificado de hora complementar é um PDF solto — fácil de perder, fácil de falsificar. Existe um mercado ativo de venda de certificado fraudulento no Brasil, crime tipificado no Código Penal, com pena de até 6 anos — tanto pra quem vende quanto pra quem compra.

O estudante carrega o risco dos dois lados: pode não receber pelo trabalho, e pode não conseguir provar que ele aconteceu.

## Bloco 2 — A Solução (~1 min)

Uma plataforma de trabalhos temporários para universitários — freela de evento, monitoria, design, criação de conteúdo, tutoria — onde cada trabalho concluído libera duas coisas ao mesmo tempo: o pagamento e um certificado.

O fluxo:

1. Contratante publica a vaga e deposita o pagamento em escrow.
2. Estudante aceita e realiza o trabalho.
3. Conclusão é confirmada (check-in/check-out, entrega aprovada).
4. No mesmo instante: o pagamento é liberado automaticamente, e um certificado é emitido — com carga horária, descrição da atividade e data — que o estudante pode apresentar à coordenação do seu curso como hora complementar, ou usar como portfólio verificável pro mercado.

Não existe mais espaço pra "empresa não paga" ou "certificado que ninguém consegue confirmar que é verdadeiro" — a mesma regra que garante o dinheiro garante a prova do trabalho.

## Bloco 3 — Por que Solana (~1 min)

Duas coisas que só uma blockchain resolve aqui, e nenhuma delas é decorativa:

**Liquidação instantânea e taxa quase zero**: viabiliza pagar uma diária de R$100-150 sem que a taxa de intermediário coma o sentido da transação, e sem o estudante esperar dias por um repasse.

**Certificado portátil e à prova de manipulação**: o certificado não pertence à plataforma — pertence à wallet do estudante. Se a plataforma sair do ar, fechar, mudar de dono, o certificado continua existindo e verificável. Isso resolve o problema de fraude pela raiz: não dá pra comprar um certificado falso quando a emissão está atrelada a um trabalho real, confirmado por duas partes, registrado publicamente.

Não estamos inventando a primitiva do zero — usamos infraestrutura de escrow que já existe e é auditável na Solana (o mesmo tipo de contrato que projetos como RentLock usam para aluguel, ou que a própria documentação da rede cita para contratos freelance). O que ninguém fez ainda é conectar isso à emissão automática de credencial acadêmica verificável — essa costura entre mercado de trabalho e vida universitária é o nosso diferencial.

## Bloco 4 — O MVP na prática (~1 min 30s)

[Aqui entram os mockups/fluxo de tela: cadastro do estudante, publicação da vaga, tela de check-in/check-out, tela do certificado emitido na wallet, exemplo de certificado com carga horária e QR/hash de verificação]

Camada de IA, horizontal ao produto — duas entradas:
- **Como categoria de serviço dentro do marketplace**: freela de criação de conteúdo com IA é hoje um dos tipos de trabalho mais demandados, e o certificado resolve exatamente o problema desse nicho — provar autoria e entrega real de algo gerado com apoio de IA.
- **Como camada interna do produto**: geração automática da descrição do certificado a partir do job concluído, apoio na redação de anúncios de vaga, e matching entre freela disponível e estudante com o perfil certo.

## Bloco 5 — Time e próximos passos (~1 min)

[Apresentação do time, cursos de origem, e próximos passos: validação com coordenações de curso sobre aceitação do certificado como hora complementar, parceria piloto com uma entidade estudantil ou produtora de evento local]

---

## Notas de produção

- **Declaração de IA obrigatória**: descrever no formulário quais ferramentas foram usadas (ex: Claude para pesquisa e estruturação do roteiro, geração de imagens/mockups se aplicável) e em quê.
- **Sem necessidade de código funcional**: mockup, fluxo desenhado ou gravação de tela contam como diferencial, não são exigidos.
- **Foco de pontuação**: problema (30%) e solução (25%) somam mais da metade da nota — os Blocos 1 e 2 merecem o maior cuidado de clareza e evidência.
