# Assistente comercial para leads de WhatsApp

Assistente de vendas para empresas que recebem leads por anúncio no WhatsApp. Para cada mensagem, ele:

- sugere a resposta, e o vendedor aprova ou edita antes de enviar (ou liga o envio automático);
- lê consumo, cidade e objeções ("tá caro", "vou pensar", "já tenho orçamento") e responde com a base da empresa;
- faz follow-up sozinho quando o lead some (24h, 48h, 96h), respeitando a regra de 24h do WhatsApp;
- marca a visita técnica quando o cliente aceita um dia e hora, e publica a agenda para o Google Agenda;
- mantém o funil (novo, em conversa, proposta, visita, fechado, perdido) e manda um resumo do dia para o vendedor.

A demonstração usa uma empresa fictícia de energia solar ("Sol do Vale Energia") com valores ilustrativos. Na implantação, a base (`data/base-conhecimento.json`) é trocada pelos dados reais da empresa.

## Rodar

Node 20.18.3 ou mais novo.

```sh
npm ci
npm test
npm run build
npm start          # http://localhost:3000
```

Sem nenhuma variável, roda em modo demonstração: WhatsApp simulado, sugestões por regras, três leads de exemplo e o botão "Avançar 24h" para ver o follow-up acontecer.

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
| `PAINEL_USUARIO`, `PAINEL_SENHA` | Login do painel. Use sempre em produção. |
| `AGENDA_TOKEN` | Protege `/agenda.ics` (`/agenda.ics?token=...`). |
| `DEMO` | `0` desliga os dados de exemplo, o simulador e o relógio da demonstração. |

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

- Texto livre só até 24h depois da última mensagem do cliente. Depois disso, só modelo aprovado pela Meta. O painel mostra se o lead está dentro ou fora da janela, e o follow-up escolhe sozinho.
- A Meta reenvia webhooks quando a resposta demora. Cada mensagem é processada uma vez só, pelo ID.
- Quem pede para sair sai do funil e não recebe mais follow-up.

## Testes

`npm test` roda 47 testes: leitura dos textos, fluxo do lead, follow-up e janela de 24h, idempotência, assinatura do webhook, login do painel, agenda .ics, validação da saída do Claude, queda para as regras quando a API falha e corrida entre respostas antigas e novas.

## Próximos passos numa implantação

- Trocar a base pela real (preços, cidades, garantias, respostas de objeção do vendedor).
- Número oficial na Cloud API da Meta, modelo de mensagem aprovado e webhook apontando para `/webhook/whatsapp`.
- Banco de dados (Postgres) no lugar da memória, para guardar o histórico entre reinícios.
- Integração com o CRM que a empresa já usa, ou manter o funil deste painel.
- Opcional: servidor MCP para o vendedor perguntar ao Claude Desktop coisas como "quem eu preciso responder hoje?".

MIT.
