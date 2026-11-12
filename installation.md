# Lillachatten – ny separat installation

**Arbetsdokument för utvecklingsgrenen `multi-instance`**  
**Referensinstallation:** `olofsgrupp` (12 november 2026)

## Princip

Varje grupp får en egen Render-webbtjänst, en egen PostgreSQL-databas och en egen administratör. Alla grupper använder samma programkod från GitHub. Medlemsuppgifter och inlägg får **inte** kopieras mellan grupperna.

Detta dokument beskriver **manuell installation**. Automatisering införs först när varje steg har provats och kontrollerats. Skapa inga resurser utan uttryckligt kostnadsgodkännande.

## 1. Uppgifter som behövs

- Gruppnamn, till exempel `Olofsgrupp`
- Unikt, enkelt tjänstenamn, till exempel `olofsgrupp`
- Administratörens e-postadress och förnamn
- Godkänd databasplan och budget

## 2. Skapa PostgreSQL i Render

Skapa en **ny** PostgreSQL-instans i samma region som webbtjänsten (för närvarande Frankfurt). Referens: `olofsgrupp-db`, betalplan `basic_256mb`, 1 GB lagringsutrymme.

Kontrollera att databasen har status **Available**. Hämta dess **Internal Database URL** från Render. Håll URL:en hemlig: den innehåller databasbehörigheter.

Använd aldrig en annan förenings `DATABASE_URL`.

## 3. Skapa en egen Render-webbtjänst

- Namn: exempelvis `olofsgrupp`
- Repository: `https://github.com/olofhess/lillachatten`
- Gren under utveckling: `multi-instance`
- Runtime: Node.js
- Region: Frankfurt
- Build command: `npm install`
- Start command: `npm start`
- Auto-deploy: på

**Viktigt:** Den befintliga installationen för Hesselmarks körs separat från denna utvecklingsgren.

## 4. Miljövariabler i den nya webbtjänsten

| Nyckel | Värde eller källa |
|---|---|
| `DATABASE_URL` | Den **nya** databasens Internal Database URL |
| `SETUP_SECRET` | En ny, stark och hemlig startkod per installation |
| `ADMIN_EMAIL` | Den nya gruppadministratörens e-postadress |
| `ADMIN_NAME` | Administratörens förnamn |
| `PUBLIC_URL` | Den nya installationens publika HTTPS-adress, t.ex. `https://olofsgrupp.onrender.com` |
| `RESEND_API_KEY` | API-nyckel från vårt befintliga Resend-konto, hanteras hemligt |
| `RESEND_FROM` | Verifierad avsändare, t.ex. `Lillachatten <inbjudan@lillachatten.se>` |

Resend-kontot och avsändardomänen kan delas mellan installationerna. **Inbjudningslänken måste däremot alltid gå till den egna installationens `PUBLIC_URL`.** Dela aldrig API-nycklar, lösenord eller databasadresser i GitHub eller i en chatt.

## 5. Första start och administratör

1. Spara miljövariablerna och driftsätt webbtjänsten.
2. Kontrollera att Render visar **Live**, att loggen anger **PostgreSQL** och att sidan öppnas via HTTPS.
3. Öppna installationen och skapa administratören med `SETUP_SECRET` och ett nytt inloggningslösenord.
4. Logga in och ange gruppens namn.
5. Bekräfta att den nya gruppen inte har medlemmar eller inlägg från någon annan installation.

## 6. Test av inbjudningar

1. Skicka en inbjudan till en separat testadress.
2. Kontrollera att sidan visar tydlig bekräftelse eller felmeddelande **utan omladdning**.
3. Kontrollera i Resend att meddelandet har accepterats, och helst status **Delivered**.
4. Kontrollera att länken i mejlet leder till **rätt installation**.
5. Acceptera inbjudan, registrera medlemmen och testa inloggning.
6. Bekräfta att medlemmen inte syns i någon annan grupp.

**Obs:** Resends status *Delivered* betyder att mottagarens mejlserver accepterat mejlet; det garanterar inte placering i inkorgen.

## 7. Drift, säkerhet och kostnader

- Dokumentera Render-tjänst, databas, ansvarig administratör och budget **utan att lagra hemligheter**.
- Separata installationer innebär separata löpande kostnader. Kontrollera aktuell prislista före varje ny installation.
- Säkerhetskopiering och återställning ska verifieras innan tjänsten erbjuds externt.
- Den befintliga gratisdatabasen för Hesselmarks hade i Render ett uppgivet utgångsdatum **9 december 2026**; dess fortsättning behöver hanteras separat.
- Gör inte en automatiserad installation förrän den kan avbrytas säkert vid fel, undvika dubbla resurser och redovisa kostnaden före skapandet.

## Nästa utvecklingssteg (inte utfört)

Skapa ett fristående installationsprogram med ett **testläge** som endast kontrollerar uppgifter och skriver ut en plan. Ingen databas eller webbtjänst skapas i testläget. Först därefter införs möjlighet till faktisk installation efter ett uttryckligt godkännande.
