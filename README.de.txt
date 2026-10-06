Verbinde deine Fox ESS-Geräte über FoxCloud mit Homey. FoxCloud aktualisiert alle fünf Minuten.

Unterstützte Geräte:
- Wechselrichter: Solarleistung und -ertrag, Wechselrichterleistung, Notstromleistung (EPS), Status und aktive Störungen. Du kannst das Einspeiselimit ins Netz festlegen.
- Batterie: Ladestand und Zustand, Leistung, geladene und entladene Energie, Temperatur und Zyklen. Homey kann die Batterie mit einer festgelegten Leistung laden und entladen, und du kannst den Betriebsmodus und die SoC-Grenzen einstellen.
- Netzzähler: Leistung pro Phase, bezogene und eingespeiste Energie, Spannung, Frequenz und Hausverbrauch.
- Wärmepumpe (Beta): Betriebsmodus und Warmwassereinstellungen, vorerst nur lesend.

Voraussetzungen: Deine Anlage muss in einem FoxCloud-Konto sein. Erstelle in FoxCloud unter Benutzerprofil > API-Verwaltung einen API-Schlüssel und gib ihn beim Hinzufügen eines Geräts ein.

⚠️ Andere Energiemanager: FoxCloud, dein Installateur, ein Energieversorger (VPP) oder eine andere App kann Homey die Steuerung der Batterie und des Einspeiselimits wieder abnehmen. Homey zeigt dann 'Steuerung überschrieben' und überlässt ihnen die Steuerung, bis du selbst wieder etwas einstellst. Wenn du die Batterie über Homey steuern willst, darf nichts anderes sie steuern (frag deinen Installateur oder Energieversorger).
