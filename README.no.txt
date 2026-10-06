Koble Fox ESS-enhetene dine til Homey via FoxCloud. FoxCloud oppdateres hvert femte minutt.

Støttede enheter:
- Vekselretter: soleffekt og -produksjon, vekselretterens effekt, nødstrøm (EPS), status og aktive feil. Du kan stille inn innmatingsgrensen til strømnettet.
- Batteri: ladenivå og helse, effekt, ladet og utladet energi, temperatur og sykluser. Homey kan lade og utlade batteriet med en valgt effekt, og du kan stille inn driftsmodus og SoC-grenser.
- Strømmåler: effekt per fase, kjøpt og innmatet energi, spenning, frekvens og husets forbruk.
- Varmepumpe (beta): driftsmodus og varmtvannsinnstillinger, foreløpig bare lesing.

Krav: anlegget ditt må ligge i en FoxCloud-konto. Opprett en API-nøkkel i FoxCloud under Brukerprofil > API-administrasjon, og skriv den inn når du legger til en enhet.

⚠️ Andre energistyringer: FoxCloud, installatøren din, en energileverandør (VPP) eller en annen app kan ta tilbake styringen av batteriet og innmatingsgrensen fra Homey. Homey viser da 'Styring overstyrt' og overlater styringen til dem til du selv endrer en innstilling igjen. Vil du styre batteriet fra Homey, må du sørge for at ingenting annet styrer det (spør installatøren eller energileverandøren din).
