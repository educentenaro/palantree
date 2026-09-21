# Palantree

CLI para encontrar valores de estilo que deveriam usar Design Tokens em projetos React. A análise usa ASTs de JavaScript, TypeScript, JSX e CSS, sem executar nem compilar o projeto analisado.

Requer Node.js 22 ou superior. React, TypeScript e Bun não precisam estar instalados globalmente.

## Instalação

Depois da publicação no npm, instale no projeto que será analisado:

```sh
npm install --save-dev palantree
npx palantree init
```

O `init` cria `design-lint.config.json` e adiciona este script ao `package.json`:

```json
{
  "scripts": {
    "lint:design": "palantree scan --fail-on-warnings"
  }
}
```

Ele usa `./src` como fonte e procura, nesta ordem, `tokens.json`, os diretórios `tokens` ou `design-tokens` e arquivos `*.tokens.json` dentro do projeto. Para informar caminhos manualmente:

```sh
npx palantree init --figma ./design-tokens/tokens.json --src ./app
```

Configurações ou scripts diferentes não são sobrescritos. Use `--force` quando quiser substituí-los deliberadamente. Se tokens ou fontes ainda não existirem, o comando conclui a configuração e mostra avisos com os caminhos pendentes.

Execute o lint com:

```sh
npm run lint:design
```

Ou diretamente:

```sh
npx palantree scan
```

`palantree` é o único executável exposto pelo pacote.

## Configuração

O arquivo gerado pelo `init` tem este formato:

```json
{
  "figma": "./tokens.json",
  "src": "./src",
  "exclude": [],
  "format": "text",
  "failOnWarnings": true
}
```

`figma` aceita um arquivo JSON ou um diretório percorrido recursivamente. Caminhos da configuração são relativos à pasta do arquivo; caminhos informados na CLI são relativos ao diretório de execução. `exclude` aceita caminhos exatos de arquivos ou diretórios, não globs.

Os argumentos de `scan` substituem as opções correspondentes:

```sh
npx palantree scan --figma ./tokens --src ./src
npx palantree scan --config ./config/lint.json
npx palantree scan --src ./src/Button.tsx --format json
npx palantree scan --fail-on-warnings
npx palantree --help
```

Sem configuração, `scan` procura `tokens.json` e `src` no diretório atual. A descoberta de `*.tokens.json` acontece durante `palantree init`; o `scan` usa exatamente o caminho salvo. O arquivo de configuração é procurado apenas no diretório atual, sem busca nas pastas pais.

## Tokens e resultado

Exemplo mínimo de `tokens.json`:

```json
{
  "spacing": {
    "md": { "$type": "dimension", "$value": "12px" }
  },
  "color": {
    "brand": { "$type": "color", "$value": "#13544A" }
  }
}
```

Ao analisar:

```tsx
export const Button = () => (
  <button style={{ color: "#13544A", padding: "12px" }}>Salvar</button>
);
```

o Palantree informa arquivo, linha, coluna, severidade e a sugestão de token. `--format json` produz um objeto com `files`, `results`, `summary` e `passed`.

| Código | Significado |
| --- | --- |
| 0 | Sem erros; warnings permitidos quando `failOnWarnings` está desativado |
| 1 | Violações, ou warnings com `failOnWarnings` ativado |
| 2 | Argumentos, configuração, leitura ou parsing inválidos |

São analisados `.tsx`, `.ts`, `.jsx`, `.js` e `.css`. Diretórios ocultos, `node_modules`, `dist`, `build`, `coverage` e `out` são ignorados. Links simbólicos encontrados na descoberta recursiva não são seguidos.

A análise cobre declarações CSS, estilos JSX e objetos CSS-in-JS. Ela não resolve imports ou expressões dinâmicas e ainda não verifica classes Tailwind/shadcn em `className` nem CSS dentro de template literals. Os tokens suportados usam folhas `$type`/`$value`.

## Desenvolvimento

```sh
npm ci
npm run check
npm test
npm run test:package
```

- `npm run build` compila `src` para `dist` como ESM compatível com Node.
- `npm test` compila e executa testes unitários, de integração e da CLI.
- `npm run test:package` empacota, instala globalmente em um prefixo temporário e verifica `init` e `scan` em um projeto React isolado.
- `npm start -- --help` mostra a ajuda da build local.

O pacote expõe somente a CLI; os módulos internos não são uma API pública estável. Nenhum script de instalação compila código na máquina do consumidor.

## Empacotamento e publicação

Antes de publicar:

```sh
npm run check
npm test
npm run test:package
npm pack --dry-run
npm pack
```

O artefato local usa o formato `palantree-<versão>.tgz`. Ele pode ser validado antes da publicação com:

```sh
npm install --save-dev ./palantree-0.1.1.tgz
npx palantree init
npx palantree scan
```

Para publicar a versão validada:

```sh
npm login
npm publish ./palantree-0.1.1.tgz --access public
```

O pacote está marcado como `UNLICENSED`: a publicação permite o download pelo npm, mas não concede uma licença aberta de redistribuição ou modificação.
