Forbind dine Fox ESS-enheder med Homey via FoxCloud. FoxCloud opdateres hvert femte minut.

Understøttede enheder:
- Inverter: soleffekt og -produktion, invertereffekt, nødstrømseffekt (EPS), status og aktive fejl. Du kan indstille leveringsgrænsen til elnettet.
- Batteri: opladningsniveau og tilstand, effekt, opladet og afladet energi, temperatur og cyklusser. Homey kan oplade og aflade batteriet med en valgt effekt, og du kan indstille driftstilstand og SoC-grænser.
- Netmåler: effekt pr. fase, købt og leveret energi, spænding, frekvens og husets forbrug.
- Varmepumpe (beta): driftstilstand og varmtvandsindstillinger, indtil videre kun læsning.

Krav: dit anlæg skal være i en FoxCloud-konto. Opret en API-nøgle i FoxCloud under Brugerprofil > API-administration, og indtast den, når du tilføjer en enhed.

⚠️ Andre energistyringer: FoxCloud, din installatør, en energileverandør (VPP) eller en anden app kan tage styringen af batteriet og leveringsgrænsen tilbage fra Homey. Homey viser så 'Styring overskrevet' og overlader styringen til dem, indtil du selv ændrer en indstilling igen. Vil du styre batteriet fra Homey, skal du sørge for, at intet andet styrer det (spørg din installatør eller energileverandør).
