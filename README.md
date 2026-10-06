# Towing J&J – sistema do guincho

Robô de WhatsApp para a equipe (dono + motoristas) e um painel que abre no celular
(Android e iPhone). Tudo em dólar e milhas.

## O que faz

- **Serviços**: cliente, retirada, destino, veículo, placa, milhas e valor (com tabela base + por milha).
- **Agenda de contatos**: importa a agenda do celular (.vcf); cliente novo que aparece entra sozinho; histórico de cada cliente.
- **Fotos (opcionais)**: antes (retirada), depois (entrega) e VIN, com data e hora.
- **VIN**: confere o número, descobre marca/modelo/ano (base gratuita da NHTSA), escaneia o código de barras pela câmera (Android) e lê o número de uma foto (Android e iPhone, precisa de `ANTHROPIC_API_KEY`).
- **Pagamentos**: Zelle, dinheiro, cartão, cheque e seguradora/motor club (AAA, Agero, Honk…). Mostra o que falta receber, quanto dinheiro está com cada motorista, e gera a mensagem de cobrança com o Zelle.
- **Despesas**: combustível, pedágio, manutenção…
- **Resumo** do dia e do mês: faturado, recebido, despesas e saldo.
- **Modular**: cada função é um módulo que pode ser ligado ou desligado. Veja [src/modules/README.md](src/modules/README.md) para criar novos.

## Comandos do robô (WhatsApp)

| Mensagem | O que faz |
|---|---|
| `novo` | Registra um serviço, perguntando passo a passo |
| `antes` / `depois` + fotos | Guarda as fotos da retirada ou da entrega |
| foto com legenda `vin` ou `vin 1HGCM82633A004352` | Salva o VIN |
| `pago 250 zelle` | Registra pagamento (zelle, dinheiro, cartão, cheque, aaa, agero…) |
| `caixa` | Quanto dinheiro/cheque está em mãos com cada motorista (acumula até o dono recolher) |
| `recolhi Jorge` / `recolhi 200 Jorge` | (dono) Pegou o dinheiro do motorista: zera, ou desconta só uma parte |
| `cobrar` | Mensagem pronta com o Zelle para encaminhar ao cliente |
| `gasto 80 diesel` | Registra despesa |
| `entregue` | Finaliza o serviço em andamento |
| `abrir 12` | Volta a mexer no serviço #12 |
| `atual`, `pendentes`, `resumo`, `resumo mes`, `ajuda`, `cancelar` | |

Quem não é da equipe (clientes, amigos) e manda mensagem para o número do robô vira contato
e recebe um "já vamos responder" no máximo uma vez por dia; o dono é avisado no WhatsApp.
Para mudar, use `WHATSAPP_RESPOSTA_FORA=nunca` (robô fica calado) ou `WHATSAPP_RESPOSTA_FORA=sempre`
(responde toda mensagem).

## Rodar no computador (para testar)

Precisa do Node.js 22.13 ou mais novo.

```bash
npm install
cp .env.example .env   # opcional
npm start              # abre em http://localhost:3000
npm test
```

No primeiro acesso o painel pede o cadastro do dono. Depois, em **Mais › Equipe**, adicione os
motoristas com o número de WhatsApp de cada um. Em **Mais › Testar o robô** dá para conversar
com o robô sem o WhatsApp configurado.

## Colocar no ar

O sistema precisa ficar num servidor com **https** e **disco que não se apaga** (o banco e as
fotos ficam na pasta `DATA_DIR`). Serve qualquer serviço que rode Docker com volume persistente
(Railway, Render, Fly.io) ou uma VPS. O `Dockerfile` já está pronto e guarda os dados em `/data`.

## Ligar o WhatsApp (API oficial da Meta)

1. Em [developers.facebook.com](https://developers.facebook.com), crie um app do tipo **Business** e adicione o produto **WhatsApp**.
2. Cadastre o número que será do robô (um chip novo; ele não pode estar em uso no app WhatsApp comum).
3. Copie o **Phone number ID** para `WHATSAPP_PHONE_NUMBER_ID` e gere um **token permanente** (usuário do sistema no Business Manager) para `WHATSAPP_TOKEN`.
4. Em **App settings › Basic**, copie o **App secret** para `WHATSAPP_APP_SECRET`.
5. Em **WhatsApp › Configuration › Webhook**, use a URL `https://SEU-ENDERECO/webhook/whatsapp`, o mesmo texto de `WHATSAPP_VERIFY_TOKEN`, e assine o campo **messages**.

A Meta cobra por conversa iniciada pela empresa; as respostas do robô às mensagens da equipe
ficam dentro da janela de 24 horas e normalmente não são cobradas como conversa nova.

## Configurações (.env)

Veja [.env.example](.env.example). As principais: `PRICE_BASE`, `PRICE_PER_MILE`, `ZELLE_NAME`,
`ZELLE_CONTACT`, `MODULES`, `TIME_ZONE` e as do WhatsApp.

## Estrutura

```
src/
  core/        núcleo: equipe, contatos, serviços e o "cérebro" do robô
  modules/     vin, fotos, pagamentos, despesas, whatsapp
  app.js       junta núcleo + módulos ligados
public/        painel (abre no navegador do celular, dá para instalar na tela inicial)
test/          testes automáticos (npm test)
```
