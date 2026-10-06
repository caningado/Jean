# Colocar o sistema no Google Cloud (grátis)

O Google dá de graça um servidor pequeno (**e2-micro**, 30 GB de disco) em algumas regiões dos EUA.
O banco de dados e as fotos ficam guardados nesse disco e não somem quando o sistema atualiza.
O futuro módulo de administração usa o mesmo banco.

> As regras do plano grátis podem mudar. Confira em https://cloud.google.com/free antes de criar.
> O Google pode cobrar alguns centavos ou poucos dólares por mês pelo IP público. Olhe a página
> **Faturamento** depois dos primeiros dias para ter certeza do valor.

Leva uns 20 minutos, no computador.

## 1. Criar a conta

1. Entre em https://console.cloud.google.com com a sua conta Google.
2. Aceite os termos e cadastre o **cartão** quando pedir. Ele serve só para verificar a conta;
   dentro do limite grátis não cobra.

## 2. Criar o servidor

1. No menu ☰, abra **Compute Engine › Instâncias de VM** e clique em **Ativar** (só na primeira vez).
2. Clique em **Criar instância** e preencha:
   - **Nome:** `towing`
   - **Região:** `us-east1` (Carolina do Sul). Também valem `us-central1` ou `us-west1`. Outras regiões cobram.
   - **Tipo de máquina:** série **E2**, tipo **e2-micro**
   - **Disco de inicialização:** clique em **Alterar**, escolha **Debian 12**, tipo **Disco permanente padrão**, tamanho **30 GB**
   - **Firewall:** marque **Permitir tráfego HTTP** e **Permitir tráfego HTTPS**
3. Clique em **Criar** e espere aparecer o ✅ verde.

## 3. Instalar o sistema

1. Na linha do servidor `towing`, clique no botão **SSH**. Abre uma tela preta.
2. Cole este comando e aperte Enter:

   ```
   curl -fsSL https://raw.githubusercontent.com/caningado/Jean/master/deploy/google-cloud/instalar.sh | sudo bash
   ```

3. Espere uns 5 minutos. No fim aparece o endereço do sistema, por exemplo
   `https://34-12-56-78.sslip.io`. Abra no celular e crie o seu acesso de dono.

## 4. Configurar Zelle, preços e WhatsApp

Na tela preta (botão **SSH**), rode:

```
sudo towing-config
```

Mude os valores, salve com **Ctrl+O** e Enter, e saia com **Ctrl+X**. O sistema reinicia sozinho.

## O que fica automático

- **Atualizações:** toda madrugada (4h de Nova York) o servidor busca a versão nova no GitHub.
  Para atualizar na hora: `sudo towing-atualizar`
- **Cópia do banco:** todo dia às 3h, em `/opt/towing/backups` (guarda 30 dias). Você também pode
  baixar a planilha com fotos pelo painel.
- Se o servidor reiniciar, o sistema liga sozinho.

## Se der problema

- Ver o erro do sistema: `sudo docker logs towing`
- O https não liga: o endereço grátis `sslip.io` às vezes atinge o limite de certificados.
  Crie um endereço grátis em https://www.duckdns.org apontando para o IP do servidor e rode
  `curl -fsSL https://raw.githubusercontent.com/caningado/Jean/master/deploy/google-cloud/instalar.sh | sudo DOMAIN=seunome.duckdns.org bash`
- Rodar o instalador de novo não apaga nada: o banco e as fotos ficam em `/opt/towing/dados`.
