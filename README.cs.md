# flexi

**Open-source back-office a AI systém pro e-shopy na Shoptetu.**

flexi propojí vaše obchody na Shoptetu s databází Postgres, se Slackem a s Claudem. Zrcadlí
objednávky a produkty, upozorní vás, když objednávka uvízne v jednom stavu, generuje
produktové feedy a přes MCP server dá Claudovi bezpečný přístup k datům vašeho obchodu, jen
k tomu, co mu povolíte.

Vznikl vytažením z interního systému firmy [Flexity](https://www.flexity.sk/), která na
Shoptetu provozuje pět obchodů (SK, CZ, HU, HR, RO), zhruba 4 500 variant produktů a přes
14 000 objednávek ročně. Jádro týmu tvoří čtyři lidé. Podrobněji v
[case study](docs/case-study.md) (anglicky).

[English](README.md) · [Architektura](docs/ARCHITECTURE.md) · [Skilly](skills/README.md) ·
[Jak přispět](CONTRIBUTING.md)

## Co funguje už dnes

| Část | Co dělá |
|---|---|
| `@flexity/shoptet` | Klient Shoptet Private API. Drží se limitů Shoptetu (3 souběžné požadavky na token, při 429 počká), bezpečně opakuje a nikdy tiše nepřestane stránkovat. |
| `@flexity/mcp` | MCP server pro Claude Code a Claude Desktop. Živé nástroje nad Shoptetem, SQL jen pro čtení nad vaším zrcadlem, token pro každého člověka s vlastními oprávněními, auditní log, zápis až po náhledu a potvrzení. |
| `mirror` | Kopíruje objednávky, položky, zákazníky, produkty, varianty, kategorie a stavy všech vašich obchodů do Postgresu a porovná obchody s hlavním. |
| `stuck-orders` | Upozornění do Slacku, když objednávka stojí v jednom stavu déle, než dovoluje vaše pravidlo, počítáno v pracovních hodinách. Nejdřív ověří, že zrcadlo je čerstvé, aby nehlásilo plané poplachy. |
| `merchant-feed` | Feedy pro Google Merchant, Heureku a Zboží.cz ze zrcadla, s validací, pravidly a pojistkou, která nepřepíše feed, když počet položek náhle spadne. |
| Skilly | 8 skillů pro Claude Code s tím, co jsme se naučili při provozu obchodů na Shoptetu. |

Potřebujete jen vlastní token Shoptet Private API. Žádná hostovaná služba, žádný účet, data
zůstávají u vás.

## Rychlý start: Claude nad vaším obchodem za dvě minuty

Potřebujete Node 20.19+, obchod na Shoptetu s přístupem k Private API (administrace,
Propojení, Private API) a Claude Code.

```sh
git clone https://github.com/flexity-git/flexi.git && cd flexi && npm install

claude mcp add flexi \
  --env FLEXI_STORES=main \
  --env SHOPTET_TOKEN_MAIN=<váš token> \
  -- "$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/bin.ts"
```

Pak se Clauda zeptejte třeba *„Jaké objednávky dnes přišly?“* Živé nástroje jen čtou. Osobní
údaje zákazníků uvidí jen ten, komu dáte oprávnění `data:read:customers`.

Plné nastavení se zrcadlem, upozorněními a feedy je v
[anglickém README](README.md#full-setup-mirror-alerts-and-feeds) a ve skillu
[`flexi-setup`](skills/flexi-setup/SKILL.md), se kterým vás Claude nastavením provede.

## Pro koho to je

- Pro obchodníky na Shoptetu, kteří už používají AI a chtějí, aby pracovala s jejich
  skutečnými daty, ne s tabulkami zkopírovanými do chatu.
- Pro agentury a vývojáře, kteří pro klienty na Shoptetu stavějí integrace a nechtějí
  pokaždé znovu řešit limity API, stránkování a bezpečný přístup k datům.

## Jak přispět

Nejjednodušší je skill: jeden soubor v markdownu s tím, co jste se naučili při provozu
obchodu. Vítané jsou i moduly (dopravci, banky, další srovnávače), opravy a překlady. Kód a
dokumentace jsou v angličtině, česky je tento soubor.

## Autor

flexi vytvořil [Tomáš Sokol](https://www.linkedin.com/in/sokoltomas/), zakladatel
[Flexity](https://www.flexity.sk/), bratislavské firmy zaměřené na pilates a wellness. Tomáš
není vývojář na plný úvazek, interní systém Flexity postavil s Claude Code jako hlavním
parťákem při programování. Na Reshoperu 2026 o tom mluví v přednášce *„Čtyři lidé, práce za
čtrnáct: Jak nám AI pomohla postavit vlastní systém“*.

Licence Apache-2.0. „Shoptet“ je ochranná známka svého vlastníka. flexi je nezávislý projekt
a se Shoptetem není spojen ani jím není schválen.
