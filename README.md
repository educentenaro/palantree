# Palantree

CLI para encontrar violações do design system em projetos React baseados em shadcn/ui. O Palantree combina uma baseline embutida de shadcn/Tailwind com os tokens semânticos exportados pelo Figma, sem executar nem compilar o projeto analisado.

Requer Node.js 22 ou superior. React, TypeScript e Bun não precisam estar instalados globalmente.

## Instalação e uso

Depois da publicação no npm, instale no projeto que será analisado e inicialize pela interface do pacote:

```sh
npm install --save-dev palantree
npx palantree init
```

Na primeira inicialização, confirme que o projeto utiliza shadcn/ui. Em terminais não interativos, use `npx palantree init --yes`. Esta versão do Palantree é exclusiva para projetos shadcn/ui.

O `init` cria `palantree.config.json`. Ele não adiciona comandos ao `package.json`; ao migrar uma configuração criada por versões anteriores, remove o script `lint:design` que o próprio Palantree gerava.

O comando detecta automaticamente as raízes de código comuns em projetos shadcn/ui, incluindo `./src`, `./app`, `./pages`, `./components`, `./routes`, `./client`, `./web`, `./ui`, `./lib` e `./hooks`. Quando nenhuma delas existe, procura pastas de código não convencionais sem incluir testes, scripts ou arquivos públicos. Também procura, nesta ordem, `tokens.json`, os diretórios `tokens` ou `design-tokens` e arquivos `*.tokens.json` dentro do projeto. Para informar um caminho manualmente:

```sh
npx palantree init --figma ./design-tokens/tokens.json --src ./app
```

Configurações diferentes não são sobrescritas. Use `--force` quando quiser substituí-las deliberadamente. Se tokens ou fontes ainda não existirem, o comando conclui a configuração e mostra avisos com os caminhos pendentes.

Execute o lint sempre pela interface do pacote:

```sh
npx palantree scan
```

`palantree` é o único executável exposto pelo pacote.

## Configuração

Em um projeto com uma única raiz, o arquivo gerado pelo `init` tem este formato:

```json
{
  "preset": "shadcn",
  "figma": "./tokens.json",
  "src": "./src",
  "exclude": [],
  "format": "text",
  "failOnWarnings": true
}
```

Projetos sem `src`, como layouts Next.js com App Router e componentes na raiz, recebem múltiplas fontes:

```json
{
  "preset": "shadcn",
  "figma": "./tokens.json",
  "src": ["./app", "./components", "./lib", "./hooks"],
  "exclude": [],
  "format": "text",
  "failOnWarnings": true
}
```

`figma` aceita um arquivo JSON ou um diretório percorrido recursivamente. `src` aceita um caminho ou uma lista de caminhos; arquivos encontrados em raízes sobrepostas são analisados uma única vez. Caminhos da configuração são relativos à pasta do arquivo; caminhos informados na CLI são relativos ao diretório de execução. `exclude` aceita caminhos exatos de arquivos ou diretórios, não globs.

Os argumentos de `scan` substituem as opções correspondentes:

```sh
npx palantree scan --figma ./tokens --src ./src
npx palantree scan --config ./config/lint.json
npx palantree scan --src ./src/Button.tsx --format json
npx palantree scan --fail-on-warnings
npx palantree --help
```

Para analisar somente `teste-palantree/app`, execute na raiz `teste-palantree`:

```sh
npx palantree scan --src ./app
```

Esse argumento substitui todas as raízes `src` configuradas e analisa somente o arquivo ou diretório indicado, mantendo as exclusões. Os tokens e o arquivo de configuração continuam sendo resolvidos independentemente da pasta selecionada.

Sem configuração, `scan` assume o preset `shadcn` e procura `tokens.json` e `src` no diretório atual; execute `init` para detectar outros layouts. Configurações com `src` como string ou sem `preset` continuam compatíveis. Um arquivo antigo chamado `design-lint.config.json` só é usado quando indicado explicitamente com `--config`. O arquivo padrão é procurado apenas no diretório atual, sem busca nas pastas pais.

## Tokens e resultado

O formato recomendado separa tokens semânticos e primitivas Light/Dark:

```json
{
  "Tokens": {
    "Default": {
      "background": {
        "bg-primary": { "$type": "color", "$value": "#FB640F" }
      }
    }
  },
  "Primitives": {
    "Light": {
      "color": { "primary": { "100": { "$type": "color", "$value": "#FB640F" } } }
    },
    "Dark": {
      "color": { "primary": { "100": { "$type": "color", "$value": "#FB640F" } } }
    }
  }
}
```

Ao analisar:

```tsx
export const Button = () => <button className="bg-[#FB640F]">Salvar</button>;
```

o Palantree informa arquivo, linha, coluna, severidade e a sugestão de token. `--format json` produz um objeto com `files`, `results`, `summary` e `passed`.

| Código | Significado |
| --- | --- |
| 0 | Sem erros; warnings permitidos quando `failOnWarnings` está desativado |
| 1 | Violações, ou warnings com `failOnWarnings` ativado |
| 2 | Argumentos, configuração, leitura ou parsing inválidos |

São analisados `.tsx`, `.ts`, `.jsx`, `.js` e `.css`. Diretórios ocultos, `node_modules`, `dist`, `build`, `coverage` e `out` são ignorados. Links simbólicos encontrados na descoberta recursiva não são seguidos.

A análise cobre declarações CSS, estilos JSX, objetos CSS-in-JS e classes Tailwind/shadcn em `className` ou `class`. Os tokens suportados usam folhas `$type`/`$value`.

Classes são extraídas de strings, trechos completos de templates, ternários, expressões lógicas e composições com `cn`, `clsx`, `classnames` e `cva`, incluindo variantes. A ferramenta não executa JavaScript, não resolve imports ou variáveis e não interpreta classes montadas por interpolação, como `bg-${color}`, nem CSS dentro de template literals.

Valores arbitrários de cores, espaçamento/dimensões, raio, tamanho de fonte e sombras geram violações. As sugestões consideram o contexto: `bg-[#FB640F]` sugere `bg-primary`, enquanto `border-[#FB640F]` sugere `border-primary`, quando esses tokens têm o mesmo valor. Variantes como `hover:` e `md:` são preservadas. Tokens semânticos shadcn aceitam modificadores numéricos de opacidade, como `bg-primary/80` e `ring-ring/50`; cores arbitrárias com opacidade continuam sendo comparadas pelo alpha final.

A baseline aceita classes nativas de layout, espaçamento, dimensões, tipografia, raio, sombra e estrutura do Tailwind/shadcn, como `px-2.5`, `text-sm`, `max-w-7xl`, `rounded-lg`, `shadow-sm` e `border-b`. Expressões geradas pelas versões atuais do shadcn, como `color-mix(...)`, `rounded-[min(var(--radius-md),12px)]` e `text-[0.8rem]`, também são reconhecidas quando permanecem apoiadas nas variáveis do tema.

Cores seguem uma regra mais estrita. Os nomes semânticos oficiais do shadcn, como `bg-background`, `text-card-foreground`, `border-border` e `ring-ring`, são aceitos, assim como nomes personalizados em `Tokens.Default`. Cores diretas da paleta Tailwind, como `text-white`, `bg-black` e `border-white/10`, continuam sendo violações e recebem uma sugestão semântica quando o JSON contém uma correspondência exata.

Somente tokens de `Tokens.Default` são sugeridos no código. `Primitives.Light` e `Primitives.Dark` servem para conferir os valores de `:root` e `.dark`. Variáveis nativas de fonte, espaçamento, raio e sombra são reconhecidas como infraestrutura do tema.

No CSS, `border: 2px solid #FB640F` sugere `border: 2px solid var(--tokens-default-border-border-primary)` e identifica o token `border-primary`. Os nomes de variáveis seguem o caminho completo do token e precisam estar definidos pelo projeto; o Palantree não gera nem injeta CSS. As sugestões não são aplicadas automaticamente.

Declarações compostas e gradientes são inspecionados por componente. Valores dentro de `var(...)` são ignorados; valores hardcoded ao lado continuam sendo analisados. Unidades relativas como `rem` não são equiparadas a `px` sem contexto de execução.

## Desenvolvimento

```sh
npm ci
npm run check
npm test
npm run test:package
```

- `npm run build` compila `src` para `dist` como ESM compatível com Node.
- `npm test` compila e executa testes unitários, de integração e da CLI.
- `npm run test:package` empacota, instala localmente em um projeto temporário e verifica `init` e `scan` com `npx --no-install palantree`.

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

O artefato local usa o formato `palantree-<versão>.tgz`. A versão atual pode ser validada com:

```sh
npm install --save-dev ./palantree-0.3.4.tgz
npx palantree init --yes
npx palantree scan
```

O pacote está marcado como `UNLICENSED`: a publicação permite o download pelo npm, mas não concede uma licença aberta de redistribuição ou modificação.
