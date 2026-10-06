Połącz urządzenia Fox ESS z Homey przez FoxCloud. FoxCloud aktualizuje dane co pięć minut.

Obsługiwane urządzenia:
- Falownik: moc i produkcja energii słonecznej, moc falownika, moc zasilania awaryjnego (EPS), stan i aktywne usterki. Możesz ustawić limit oddawania do sieci.
- Akumulator: poziom naładowania i stan zdrowia, moc, energia naładowana i rozładowana, temperatura i cykle. Homey może ładować i rozładowywać akumulator z ustaloną mocą, a Ty możesz ustawić tryb pracy i limity SoC.
- Licznik sieciowy: moc na fazę, energia pobrana i oddana, napięcie, częstotliwość i zużycie domu.
- Pompa ciepła (beta): tryb pracy i ustawienia ciepłej wody, na razie tylko do odczytu.

Wymagania: Twoja instalacja musi być na koncie FoxCloud. Utwórz klucz API w FoxCloud w Profil użytkownika > Zarządzanie API i wpisz go podczas dodawania urządzenia.

⚠️ Inne systemy zarządzania energią: FoxCloud, instalator, dostawca energii (VPP) lub inna aplikacja mogą przejąć od Homey sterowanie akumulatorem i limitem oddawania do sieci. Homey pokazuje wtedy „Sterowanie nadpisane” i pozostawia im sterowanie, dopóki sam ponownie czegoś nie ustawisz. Aby sterować akumulatorem z Homey, upewnij się, że nic innego nim nie steruje (zapytaj instalatora lub dostawcę energii).
