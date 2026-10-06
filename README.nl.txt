Verbind je Fox ESS-apparaten met Homey via FoxCloud. FoxCloud werkt elke vijf minuten bij.

Ondersteunde apparaten:
- Omvormer: zonnevermogen en -opbrengst, omvormervermogen, noodstroomvermogen (EPS), status en actieve storingen. Je kunt de terugleverlimiet aan het net instellen.
- Batterij: laadtoestand en gezondheid, vermogen, geladen en ontladen energie, temperatuur en cycli. Homey kan de batterij laden en ontladen met een gekozen vermogen, en je kunt de werkmodus en SoC-grenzen instellen.
- Netmeter: vermogen per fase, import- en exportenergie, spanning, frequentie en huisverbruik.
- Warmtepomp (bèta): werkmodus en warmwaterinstellingen, voorlopig alleen-lezen.

Vereisten: je installatie moet in een FoxCloud-account staan. Maak een API-sleutel aan in FoxCloud onder Gebruikersprofiel > API-beheer, en vul die in wanneer je een apparaat toevoegt.

⚠️ Andere energiebeheerders: FoxCloud, je installateur, een energieleverancier (VPP) of een andere app kan de sturing van de batterij en de terugleverlimiet van Homey overnemen. Homey toont dan 'Sturing overschreven' en laat de sturing aan hen tot je zelf weer iets instelt. Wil je de batterij vanuit Homey sturen, zorg dan dat niets anders hem stuurt (vraag je installateur of energieleverancier).
