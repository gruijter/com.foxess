Collega i tuoi dispositivi Fox ESS a Homey tramite FoxCloud. FoxCloud si aggiorna ogni cinque minuti.

Dispositivi supportati:
- Inverter: potenza e produzione solare, potenza dell'inverter, potenza di backup (EPS), stato e guasti attivi. Puoi impostare il limite di immissione in rete.
- Batteria: stato di carica e di salute, potenza, energia caricata e scaricata, temperatura e cicli. Homey può caricare e scaricare la batteria a una potenza impostata, e puoi impostare la modalità di funzionamento e i limiti di SoC.
- Contatore di rete: potenza per fase, energia prelevata e immessa, tensione, frequenza e consumo della casa.
- Pompa di calore (beta): modalità di funzionamento e impostazioni dell'acqua calda, per ora in sola lettura.

Requisiti: il tuo impianto deve essere in un account FoxCloud. Crea una chiave API in FoxCloud in Profilo utente > Gestione API e inseriscila quando aggiungi un dispositivo.

⚠️ Altri gestori energetici: FoxCloud, il tuo installatore, un fornitore di energia (VPP) o un'altra app possono riprendere da Homey il controllo della batteria e del limite di immissione. Homey mostra allora «Controllo sovrascritto» e lascia loro il controllo finché non modifichi di nuovo un'impostazione. Per controllare la batteria da Homey, assicurati che nient'altro la controlli (chiedi al tuo installatore o fornitore di energia).
