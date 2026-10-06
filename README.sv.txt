Anslut dina Fox ESS-enheter till Homey via FoxCloud. FoxCloud uppdateras var femte minut.

Enheter som stöds:
- Växelriktare: soleffekt och -produktion, växelriktarens effekt, reservkraft (EPS), status och aktiva fel. Du kan ställa in inmatningsgränsen till elnätet.
- Batteri: laddningsnivå och hälsa, effekt, laddad och urladdad energi, temperatur och cykler. Homey kan ladda och ladda ur batteriet med en vald effekt, och du kan ställa in driftläge och SoC-gränser.
- Elmätare: effekt per fas, köpt och inmatad energi, spänning, frekvens och husets förbrukning.
- Värmepump (beta): driftläge och varmvatteninställningar, tills vidare endast läsning.

Krav: din anläggning måste finnas i ett FoxCloud-konto. Skapa en API-nyckel i FoxCloud under Användarprofil > API-hantering och ange den när du lägger till en enhet.

⚠️ Andra energihanterare: FoxCloud, din installatör, ett energibolag (VPP) eller en annan app kan ta tillbaka styrningen av batteriet och inmatningsgränsen från Homey. Homey visar då 'Styrning överskriven' och lämnar styrningen till dem tills du själv ändrar en inställning igen. Vill du styra batteriet från Homey måste du se till att inget annat styr det (fråga din installatör eller ditt energibolag).
