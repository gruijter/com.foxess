Connectez vos appareils Fox ESS à Homey via FoxCloud. FoxCloud se met à jour toutes les cinq minutes.

Appareils pris en charge :
- Onduleur : puissance et production solaires, puissance de l'onduleur, puissance de secours (EPS), état et défauts actifs. Vous pouvez régler la limite d'injection sur le réseau.
- Batterie : état de charge et de santé, puissance, énergie chargée et déchargée, température et cycles. Homey peut charger et décharger la batterie à une puissance donnée, et vous pouvez régler le mode de fonctionnement et les limites de SoC.
- Compteur réseau : puissance par phase, énergie soutirée et injectée, tension, fréquence et consommation de la maison.
- Pompe à chaleur (bêta) : mode de fonctionnement et réglages d'eau chaude, en lecture seule pour l'instant.

Prérequis : votre installation doit figurer dans un compte FoxCloud. Créez une clé API dans FoxCloud sous Profil utilisateur > Gestion des API, et saisissez-la lors de l'ajout d'un appareil.

⚠️ Autres gestionnaires d'énergie : FoxCloud, votre installateur, un fournisseur d'énergie (VPP) ou une autre application peut reprendre à Homey le pilotage de la batterie et de la limite d'injection. Homey affiche alors « Pilotage écrasé » et leur laisse le pilotage jusqu'à ce que vous modifiiez à nouveau un réglage. Pour piloter la batterie depuis Homey, assurez-vous que rien d'autre ne la pilote (demandez à votre installateur ou à votre fournisseur d'énergie).
