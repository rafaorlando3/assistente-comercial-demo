# Assistente comercial para leads de WhatsApp

Assistente de vendas para empresas que recebem leads por anúncio no WhatsApp. Para cada mensagem, ele:

- sugere a resposta, e o vendedor aprova ou edita antes de enviar (ou liga o envio automático);
- lê consumo, cidade e objeções ("tá caro", "vou pensar", "já tenho orçamento") e responde com a base da empresa;
- prepara o follow-up quando o lead some: 1º 24h depois da nossa última mensagem, 2º 48h depois do 1º e 3º 96h depois do 2º (dias 1, 3 e 7). Respeita a regra de 24h do WhatsApp;
- marca a visita técnica quando o cliente aceita um dia e hora, e publica a agenda para o Google Agenda;
- mantém o funil (novo, em conversa, proposta, visita, fechado, perdido) e gera o resumo do dia para o vendedor (o envio automático às 8h fica para a implantação).

A demonstração usa uma empresa fictícia de energia solar ("Sol do Vale Energia") com valores ilustrativos. Na implantação, a base (`data/base-conhecimento.json`) é trocada pelos dados reais da empresa.

## Rodar

Node 20.18.3 ou mais novo.

```sh
npm ci
npm test
npm run build
npm start          # http://localhost:3000
```

Sem nenhuma variável, roda em modo demonstração:
- WhatsApp simulado, sugestões por regras e webhook desligado;
- três leads fictícios e o botão "Avançar 24h" para ver o follow-up acontecer;
- novos leads com telefone fictício gerado pelo servidor, textos de até 500 caracteres, no máximo 30 leads e o botão "Reiniciar".

A demonstração **recusa iniciar** se houver credencial externa no ambiente (WhatsApp ou Anthropic). Assim ela nunca fala com serviços de fora.

Com `DEMO=0` (uso real):
- `PAINEL_USUARIO` e `PAINEL_SENHA` são obrigatórios; sem eles o servidor não inicia;
- a agenda `.ics` exige `AGENDA_TOKEN` ou o mesmo login.

## Variáveis de ambiente

Nenhuma chave fica em arquivo. No Render (ou outro serviço), use o painel de variáveis de ambiente.

| Variável | Para quê |
| --- | --- |
| `ANTHROPIC_API_KEY` e `ANTHROPIC_MODEL` | Liga o Claude para escrever as sugestões. Sem elas, valem as regras. Se a API falhar, o atendimento cai para as regras e continua. |
| `WHATSAPP_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` | Envio real pela WhatsApp Business Cloud API (Meta). Sem elas, o envio é simulado. |
| `WHATSAPP_VERIFY_TOKEN` | Token da verificação do webhook (`GET /webhook/whatsapp`). |
| `WHATSAPP_APP_SECRET` | Confere a assinatura `X-Hub-Signature-256` de cada webhook. Sem ela, webhooks reais são recusados. |
| `GRAPH_API_VERSION` | Versão da Graph API (padrão `v21.0`). |
| `MODELO_FORA_DA_JANELA`, `MODELO_IDIOMA` | Nome e idioma do modelo de mensagem aprovado na Meta para follow-up depois de 24h (padrão `retomada_atendimento`, `pt_BR`). |
| `MODO` | `sugerir` (padrão: o vendedor aprova) ou `automatico`. |
| `PAINEL_USUARIO`, `PAINEL_SENHA` | Login do painel. Obrigatório com `DEMO=0`. |
| `AGENDA_TOKEN` | Token de `/agenda.ics?token=...` para o Google Agenda assinar. Sem ele, a agenda pede o login do painel. |
| `DEMO` | `0` liga o uso real. Qualquer outro valor é demonstração: sem credenciais externas, sem webhook e com dados fictícios. |

## Como funciona

```
WhatsApp (Meta) ──webhook assinado──► /webhook/whatsapp ──► Assistente.receber()
                                                              │  idempotente pelo ID da mensagem
                                                              ▼
                                   Claude (se configurado) ou regras ──► sugestão
                                                              │
                        vendedor aprova no painel (ou modo automático)
                                                              ▼
                               Cloud API envia ──► CRM atualiza etapa e agenda
                                                              │
                      a cada minuto: follow-ups devidos (texto até 24h; depois, modelo aprovado)
```

- `src/whatsapp.ts`: verificação do webhook, assinatura HMAC, leitura das mensagens (texto e botões) e envio por texto ou modelo.
- `src/regras.ts` e `src/texto.ts`: leitura de consumo, cidade, objeção, pedido para sair e horário de visita em português (fuso de Brasília).
- `src/claude.ts`: chamada à API da Anthropic com a base da empresa no prompt, saída em JSON validada. A mensagem do lead vai como dado, e o prompt manda ignorar instruções vindas dela.
- `src/crm.ts`: tarefas, follow-up, leads esfriando e resumo do dia.
- `src/agenda.ts`: agenda de visitas em iCalendar. No Google Agenda: "Outras agendas > Do URL" com o endereço de `/agenda.ics`.
- `src/server.ts`: servidor HTTP sem dependências e o painel (`public/index.html`).

## Regras do WhatsApp que o sistema respeita

- Texto livre só até 24h depois da última mensagem do cliente, contando pela hora da mensagem, não pela hora em que o webhook chegou. Uma entrega atrasada não reabre a janela.
- Depois das 24h, só um modelo aprovado pela Meta. O painel mostra se o lead está dentro ou fora da janela. Nesse caso, o texto não pode ser editado, e o histórico registra o nome do modelo e o parâmetro, não um texto inventado.
- A Meta reenvia webhooks quando a resposta demora. Cada mensagem é processada uma vez só, pelo ID (em memória).
- Quem pede para sair sai do funil e não recebe mais follow-up.
- Um horário citado junto com negativa, cancelamento ou remarcação ("não posso amanhã às 10h") não marca visita. Dois horários na mesma mensagem também não: o assistente pede confirmação. Datas que não existem (31/02) são recusadas.
- Cada sugestão tem uma versão. O vendedor aprova a versão que viu. Se chegou mensagem nova nesse meio tempo, nada é enviado e o painel mostra a sugestão atual. Aprovação e follow-up do mesmo lead rodam um de cada vez.

## Testes

`npm test` roda 72 testes. Eles cobrem:
- leitura dos textos e horários;
- fluxo do lead, cadência do follow-up e janela de 24h pela hora da mensagem;
- idempotência e assinatura do webhook;
- versão da sugestão e aprovações concorrentes;
- demonstração sem saída externa;
- login, agenda protegida e envio sem identificador;
- validação da saída do Claude e queda para as regras.

## Limites conhecidos (antes de uso real)

- Estado em memória: reiniciar apaga leads, sugestões e a deduplicação. O webhook responde 200 antes de processar, sem fila durável.
- O envio não tem estado "desconhecido" persistido. Um envio sem identificador vira erro e não é registrado como enviado; não há reconsulta automática.
- O follow-up roda num temporizador do processo. Um serviço que hiberna sem tráfego não faz follow-up nesse período.
- Envio real pela Cloud API e modelo aprovado ainda não foram testados contra a Meta.

## Próximos passos numa implantação

- Trocar a base pela real (preços, cidades, garantias, respostas de objeção do vendedor).
- Número oficial na Cloud API da Meta, modelo de mensagem aprovado e webhook apontando para `/webhook/whatsapp`.
- Banco de dados (Postgres) no lugar da memória, para guardar o histórico entre reinícios.
- Integração com o CRM que a empresa já usa, ou manter o funil deste painel.
- Opcional: servidor MCP para o vendedor perguntar ao Claude Desktop coisas como "quem eu preciso responder hoje?".

MIT.
