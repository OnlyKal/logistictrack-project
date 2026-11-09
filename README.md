# LogisticTrack

Plateforme SaaS multi-entreprises de gestion logistique : entrepôts, stocks, commandes, colis, livraisons, chauffeurs, suivi GPS par le téléphone, preuves de livraison et abonnements.

| Dossier | Application | Technologies |
|---|---|---|
| `server/` | API REST et WebSocket | Node.js, NestJS, TypeScript, Prisma, Socket.IO, BullMQ |
| `web/` | Administration, gestion et portail public de suivi | React, Vite, Lucide, Leaflet (OpenStreetMap) |
| `mobile/` | Application chauffeur (Android et iOS) | Flutter, SQLite local |

Base de données : SQLite en développement, MySQL 8 en production. Redis est facultatif en développement.

## Démarrage en développement

Prérequis : Node.js 22, Flutter 3.35.

### 1. Serveur

```sh
cd server
npm install
cp .env.example .env
npx prisma migrate deploy
SUPERADMIN_PASSWORD='choisir-un-mot-de-passe' npm run db:demo
npm run dev
```

- API : `http://localhost:3000/api/v1`
- Documentation Swagger : `http://localhost:3000/api/docs` (routes uniquement, hors production)
- `GET /health` vérifie que le serveur fonctionne.

`npm run db:demo` crée le Super Administrateur et une entreprise de démonstration. Mot de passe des comptes de démonstration : `Demo1234!`.

| Compte | Identifiant |
|---|---|
| Super Administrateur | `admin@logistictrack.local` |
| Administrateur d'entreprise | `admin@demo-logistique.local` |
| Responsable logistique | `logistique@demo-logistique.local` |
| Responsable d'entrepôt | `entrepot@demo-logistique.local` |
| Chauffeur (mobile) | `+243990000001` |

### 2. Web

```sh
cd web
npm install
npm run dev
```

Vite relaie `/api` et `/socket.io` vers le serveur. Le portail public de suivi est sur `/suivi-colis`.

### 3. Mobile

```sh
cd mobile
flutter pub get
flutter run --dart-define=API_URL=http://<adresse-ip-du-serveur>:3000
```

Sans `API_URL`, l'application utilise le serveur en ligne `https://www.logisticstraack.com` (`mobile/lib/core/config.dart`). En développement, `API_URL` permet de viser son ordinateur ; le HTTP en clair n'est autorisé qu'en debug.

Application Android à installer sur les téléphones : `flutter build apk --release`, puis `build/app/outputs/flutter-apk/app-release.apk`.

## Tests

```sh
cd server && npm test                  # 111 tests de bout en bout sur une base SQLite isolée (attaques entre entreprises : test/isolation.test.ts)
cd mobile && flutter test test         # logique GPS et missions
cd mobile && flutter test integration_test/driver_flow_test.dart -d <appareil> --dart-define=API_URL=http://localhost:3000
```

Les tests d'intégration mobile s'exécutent contre un serveur en marche, avec le jeu de démonstration. Ils créent de vraies livraisons : réinitialisez ensuite la base de développement si besoin.

## Mise en production

1. **Secrets** : `JWT_SECRET`, `FILE_URL_SECRET` et `PAYMENT_WEBHOOK_SECRET` doivent comporter au moins 32 caractères aléatoires. Le serveur refuse de démarrer sinon.
2. **MySQL 8** : définir `DATABASE_URL="mysql://…"`, puis :
   ```sh
   npm run db:mysql:generate   # génère le schéma et le client Prisma pour MySQL
   npm run db:mysql:deploy     # applique prisma/mysql/migrations
   SUPERADMIN_PASSWORD='…' npm run db:seed
   ```
3. **Redis** : définir `REDIS_URL` pour le WebSocket entre plusieurs instances et les tâches BullMQ.
4. **Web** : `npm run build`, puis servir `web/dist` et relayer `/api` et `/socket.io` vers le serveur en HTTPS. Le serveur doit aussi connaître l'origine publique dans `WEB_ORIGINS`.
5. **Mobile** : l'identifiant est `com.logistictrack.app` (Android et iOS). L'adresse de production est déjà l'adresse par défaut ; signer les applications avant de les publier dans les stores.
6. **Fichiers** : `STORAGE_DIR` doit pointer vers un volume persistant et sauvegardé.
7. **E-mail et sauvegardes** : voir les deux sections ci-dessous. `WEB_PUBLIC_URL` doit être l'adresse publique du web, pour les liens envoyés par e-mail.

Le modèle de données se modifie uniquement dans `server/prisma/schema.prisma`. Le schéma MySQL en est généré. Après une modification, créez la migration sur les deux moteurs : `npm run db:migrate` pour SQLite, puis `prisma migrate diff` sur `prisma/mysql/schema.prisma` pour MySQL.

## Envoi des e-mails (Gmail)

Les e-mails (lien de réinitialisation du mot de passe, notifications) partent par SMTP. Pour Gmail :

1. Activez la validation en deux étapes sur le compte Google qui enverra les e-mails.
2. Créez un **mot de passe d'application** : https://myaccount.google.com/apppasswords. C'est un code de 16 lettres, différent du mot de passe du compte. Le mot de passe normal du compte ne fonctionne pas.
3. Connecté en Super Administrateur, ouvrez **Mon compte**, carte « Envoi des e-mails ». Saisissez le serveur (`smtp.gmail.com`, port 465, SSL coché), l'adresse Gmail, le mot de passe d'application sans espaces, puis **Enregistrer**. C'est pris en compte immédiatement, sans redémarrage. Le mot de passe est chiffré en base (AES-256-GCM, clé dérivée de `JWT_SECRET`) et n'est jamais réaffiché : laissez le champ vide pour le conserver. Si `JWT_SECRET` change, l'écran demande de le ressaisir.
4. Le bouton « Envoyer un e-mail de test » vérifie l'envoi réel.

Solution de secours : sans réglages dans l'administration, le serveur utilise ceux de `server/.env` (le bouton « Revenir au fichier .env » supprime les réglages de l'administration) :
   ```sh
   MAIL_HOST=smtp.gmail.com
   MAIL_PORT=465
   MAIL_SECURE=true
   MAIL_USER=adresse@gmail.com
   MAIL_PASSWORD=abcdefghijklmnop        # le mot de passe d'application, sans espaces
   MAIL_FROM="LogisticTrack <adresse@gmail.com>"
   WEB_PUBLIC_URL=https://app.votre-domaine.com
   ```
   Puis redémarrez le serveur.

`WEB_PUBLIC_URL` (adresse des liens envoyés) reste dans `server/.env` dans tous les cas. Ce fichier ne doit jamais être partagé ni copié dans le code. Gmail limite l'envoi à environ 500 e-mails par jour.

**Quand partent les e-mails** (`server/src/common/emails.service.ts`, `server/src/modules/deliveries/customer-mail.service.ts`) :

| Groupe | E-mail | Destinataire |
|---|---|---|
| Comptes | Invitation à choisir son mot de passe (lien valable 7 jours), si aucun mot de passe initial n'est saisi | Nouvel administrateur ou utilisateur |
| | Bienvenue, sans le mot de passe, si un mot de passe initial est saisi | Idem |
| | Lien de réinitialisation : demandé (1 heure) ou envoyé par l'administrateur (24 heures) | Titulaire du compte |
| | Alertes : mot de passe modifié, compte bloqué après 6 essais | Titulaire du compte |
| Abonnement | Facture émise (demande, ou nouveau prix fixé par le Super Admin) | Administrateurs principaux et adresse de l'entreprise |
| | Facture à encaisser | Super Administrateurs |
| | Reçu de paiement | Administrateurs principaux et adresse de l'entreprise |
| | Rappels à J-7, J-3 et J-1 (essai : la veille seulement), période de grâce, lecture seule | Idem |
| Clients | En route (lien de suivi en direct, sans nom ni téléphone du chauffeur), livrée (accusé de réception en PDF), non effectuée (motif) | Le client, si l'entreprise l'a activé dans Paramètres et si le client ne l'a pas refusé |

Un e-mail ne bloque ni ne fait échouer une opération : il part en arrière-plan. L'invitation est la seule exception : son résultat s'affiche aussitôt. Chaque envoi est inscrit au journal des e-mails, avec la cause en cas d'échec. Le Super Admin le consulte dans Mon compte, et chaque entreprise dans Paramètres. Un rappel ne part jamais deux fois. Le rappel d'un chauffeur par le bureau n'est pas signalé au client.

**Suivi en ligne par le client** (`/suivi-colis/<jeton>?k=<clé>`, `server/src/modules/tracking/public-tracking.service.ts`) :

- **Le lien** : il est envoyé dans l'e-mail « en route ». Le bureau peut aussi le copier depuis la fiche de la livraison, avec le bouton « Lien de suivi client ». Il réunit le jeton aléatoire du colis (192 bits) et une clé signée par le serveur (HMAC). Aucun compte n'est nécessaire.
- **La recherche par numéro de suivi** (imprimé sur l'étiquette) ne montre que l'état et les étapes : jamais la carte ni l'adresse exacte.
- **La carte** montre la position du véhicule, le parcours depuis le départ, la destination, la distance restante à vol d'oiseau et l'heure du dernier signal. Elle n'est visible que pendant le trajet (état « En route »). À l'arrivée et après la livraison, plus aucune position n'est montrée.
- **Pendant une tournée** : quand le chauffeur est chez un autre client, sa position est masquée. Le parcours ne commence qu'à la fin de son dernier arrêt. Les adresses des autres clients ne sont donc jamais révélées.
- **Jamais affichés** : le nom, le téléphone ou la batterie du chauffeur, l'immatriculation, l'entrepôt, le nom du client, les numéros internes. Seules la raison commerciale et les coordonnées publiques de l'entreprise apparaissent.
- **Temps réel** : WebSocket public, sur une salle propre à la livraison, ouverte seulement avec un jeton et une clé valides. Il reçoit uniquement des positions filtrées et des signaux de mise à jour. Si la connexion tombe, la page se recharge d'elle-même toutes les 15 secondes.

**Design des documents** : e-mails, PDF (livraisons, rapports) et exports Excel partagent un seul design (`server/src/common/pdf.ts`). Chacun porte le logo, le nom, les coordonnées, le NIF et le RCCM de l'entreprise concernée, ou l'initiale de l'entreprise dans un carré bleu si elle n'a pas de logo. Un e-mail d'entreprise s'affiche « Entreprise via LogisticTrack », et les réponses vont à l'adresse de l'entreprise. Les e-mails de la plateforme sont signés LogisticTrack. Dans Mon compte, l'e-mail de test peut être envoyé aux couleurs de n'importe quelle entreprise.

## Sauvegardes et restauration

Le serveur sauvegarde la base et les fichiers (preuves, photos, signatures, logos) une fois par jour, et une minute après chaque démarrage si la dernière sauvegarde a plus de 24 heures. Chaque sauvegarde est un dossier daté dans `BACKUP_DIR`, avec la base, les fichiers et un `manifest.json` (taille et empreinte SHA-256). Les sauvegardes plus anciennes que `BACKUP_KEEP_DAYS` (14 jours par défaut) sont supprimées, la plus récente est toujours gardée.

- **Copie hors du serveur** : `BACKUP_COPY_DIR` peut pointer vers un autre disque ou un dossier synchronisé (disque externe, Google Drive, Dropbox). Une sauvegarde qui reste sur la même machine ne protège pas contre la perte de cette machine.
- **Manuellement** : `npm run backup`, ou le bouton « Sauvegarder maintenant » dans **Mon compte**.
- **MySQL** : la base est exportée par `mysqldump` (compressé). L'outil doit être installé sur le serveur, ou indiqué par `MYSQLDUMP_PATH`.
- **Restaurer** : arrêtez le serveur, puis lancez `npm run restore -- backups/<dossier>`. La base et les fichiers actuels sont d'abord mis de côté. Redémarrez ensuite le serveur.

## Sécurité des comptes

- **Blocage** : après 6 mots de passe faux de suite, le compte est bloqué 15 minutes, quel que soit l'appareil. Une réinitialisation par l'administrateur ou par e-mail le débloque.
- **Administrateurs** : seul l'administrateur principal peut nommer, modifier ou désactiver un administrateur principal. Un administrateur secondaire ne peut pas donner une permission qu'il n'a pas, ni modifier ses propres droits.
- **Fichiers reçus** : le serveur vérifie le contenu réel (PNG, JPEG, WEBP ou PDF), pas seulement l'extension.
- **Sessions** : elles n'expirent pas, sur le web comme sur le mobile, tant que l'utilisateur ne se déconnecte pas. Changer son mot de passe déconnecte les autres appareils.

## Import CSV et stock passé

- **Import** : Marchandises, Clients et Stocks ont un bouton « Importer ». Téléchargez le modèle, remplissez-le dans Excel, puis déposez le fichier. Le séparateur `;` ou `,`, la virgule décimale et les accents sont acceptés. Le fichier est d'abord vérifié : à la moindre erreur, rien n'est enregistré et chaque ligne fautive est indiquée. Les marchandises existantes (même référence) sont mises à jour. Le stock initial crée des mouvements tracés « Stock initial importé (CSV) ».
- **Stock à une date** : dans Stocks, le champ « Stock au » affiche le stock physique à la fin du jour choisi, reconstitué à partir des mouvements.
- **Fuseau horaire** : rapports, PDF et filtres par date suivent le fuseau de l'entreprise (Paramètres), et non celui du serveur.

## Serveur de production (www.logisticstraack.com)

Serveur Ubuntu 24.04 partagé avec d'autres sites : LogisticTrack y est isolé.

| Élément | Emplacement |
|---|---|
| Code du serveur | `/opt/logistictrack/server` (configuration : `.env`, lisible par le seul compte `logistictrack`) |
| Site web compilé | `/opt/logistictrack/web` |
| Node.js 22 propre à l'application | `/opt/logistictrack/node` (le Node.js du système sert aux autres sites) |
| Fichiers et sauvegardes | `/opt/logistictrack/data/storage`, `/opt/logistictrack/data/backups` |
| Base MySQL | base `logistictrack`, utilisateur `logistictrack`, droits limités à cette base |
| Service | `systemctl status logistictrack`, journaux : `journalctl -u logistictrack -f` |
| Nginx | `/etc/nginx/sites-available/logisticstraack.com` ; le serveur écoute seulement sur `127.0.0.1:3210` |
| HTTPS | Let's Encrypt, renouvelé automatiquement (`certbot.timer`) |

**Mettre à jour** : depuis le dossier du projet, lancez `./deploy.sh`. Le script enchaîne tout :
1. les tests ;
2. la compilation du site web et l'envoi du code ;
3. une sauvegarde de la base en ligne ;
4. la compilation sur le serveur et les migrations MySQL ;
5. le redémarrage et la vérification.

Il refuse de mettre en ligne si un test échoue, ou si le modèle de données a changé sans migration MySQL. Si le serveur ne redémarre pas, il revient seul à la version précédente.

Une nouvelle migration MySQL se crée sur le poste de développement avec `prisma migrate diff` (voir « Mise en production »), avant la mise à jour.

## Règles d'architecture

- **Isolation** : chaque donnée métier porte `companyId`. L'entreprise active vient de la session, jamais du client. Hors d'une entreprise, le Super Administrateur n'agit sur aucune opération. Avec « Gérer cette entreprise », sa session bascule sur l'entreprise choisie, même suspendue : il y dispose des droits de l'administrateur principal, sans en devenir membre, et ne voit qu'elle. Entrée, sortie et chaque écriture sont inscrites dans le journal de cette entreprise.
- **Autorisations** : rôles et permissions dans `server/src/common/constants.ts`, avec un périmètre par entrepôt.
- **Codes** : le code d'un entrepôt (`ENT-2026-000001`) ou d'une agence (`AGC-2026-000001`) est toujours généré par le serveur, unique dans l'entreprise, et ne change plus.
- **Stocks** : aucun solde ne change sans mouvement tracé (`StockService.apply`). Verrouillage optimiste par version et rejeu complet de la transaction, portable SQLite et MySQL.
- **Livraisons** : les transitions d'état autorisées sont dans `DELIVERY_TRANSITIONS`. Le stock sort au chargement, et une confirmation exige les preuves configurées par l'entreprise.
- **GPS** : uniquement ce que le téléphone mesure, seulement sur la route : le suivi commence au départ et s'arrête à l'arrivée, côté téléphone comme côté serveur, y compris hors ligne. Les actions du chauffeur (arrivée, preuve) enregistrent seulement une position ponctuelle. Jamais de valeur inventée. Après 120 secondes sans signal, une position n'est plus présentée comme « en direct ».
- **Hors ligne** : le mobile enregistre ses positions et ses opérations dans sa base SQLite, avec un identifiant unique et leur heure réelle. Au retour du réseau, tout part automatiquement, dans l'ordre et sans doublon (vérification toutes les 15 secondes et à chaque changement de réseau). Rien n'est présenté comme confirmé avant la réponse du serveur. Si le bureau a terminé la mission entre-temps, le trajet déjà mesuré est conservé, jamais ce qui suit l'arrivée.
- **Design** : Lucide uniquement, aucun dégradé, aucun emoji, bleu `#2563EB` en accent.

## Abonnements

Il n'y a pas de formules. Une nouvelle entreprise commence par 3 jours d'essai gratuit, sans facture ni période de grâce. Ensuite, c'est elle qui s'abonne et choisit sa durée. Le Super Administrateur fixe seulement son montant mensuel, sa devise et, si besoin, ses limites (une limite vide signifie illimité). Il peut les changer à tout moment : une facture en attente est alors remplacée au nouveau montant. Le formulaire de création propose par défaut : 200 par mois, 7 jours de grâce, 5 entrepôts, 7 utilisateurs, 10 chauffeurs et 7 véhicules.

| Durée | 1 mois | 3 mois | 6 mois | 12 mois | 24 mois |
|---|---|---|---|---|---|
| Remise | 0 % | 5 % | 9 % | 12 % | 25 % |

Le serveur calcule seul les montants (`SUBSCRIPTION_DISCOUNTS`). L'entreprise peut changer de durée ou se réabonner, même après expiration, mais jamais changer son prix. Sa demande émet une facture : rien ne change avant le règlement. Le paiement en ligne n'est pas encore branché : le Super Administrateur enregistre les règlements dans Factures.

**Abonnement expiré** : l'entreprise passe en lecture seule, rien n'est supprimé. Une mission déjà chargée ou en route peut aller jusqu'au bout (GPS, preuves, confirmation, échec, retour au stock), pour ne pas bloquer une marchandise sur la route. Aucune nouvelle mission ne peut démarrer.

## Reste à faire avant une mise en production réelle

- **MySQL** : les migrations ont été appliquées sur MySQL 8.0 en production (novembre 2026), base conforme au modèle. La suite de tests, elle, tourne sur SQLite.
- **GPS réel** : le code de collecte, l'arrière-plan et l'écran verrouillé n'ont pas été testés sur un téléphone physique. La transmission et la synchronisation des positions, elles, sont testées.
- **Envois sortants** : l'e-mail fonctionne une fois le compte d'envoi saisi dans Mon compte (voir plus haut). SMS et WhatsApp n'ont pas encore de fournisseur.
- **Paiements** : paiement manuel et webhook HMAC générique. Aucun prestataire réel (Mobile Money, carte) n'est connecté.
- **Notifications push mobiles** : non branchées, car un projet Firebase est nécessaire. Le chauffeur voit ses missions en rafraîchissant ou lors des synchronisations.
- **Fichiers** : stockage sur disque. S3 se branche en remplaçant `FileService`.
- **Traduction** : l'interface est en français, l'anglais n'est pas encore disponible.
- **Non réalisés** : tests de charge, conteneurs Docker et Nginx. La restauration MySQL n'a pas été répétée sur un vrai serveur.

## Écarts assumés par rapport au cahier des charges

Décisions prises dans la conversation de référence :

- Le backend Django et PostgreSQL du cahier initial est remplacé par Node.js, avec SQLite et MySQL. Il n'y a donc pas de Row Level Security : l'isolation est assurée par le serveur et couverte par les tests.
- Le GPS est simplifié : pas de géorepérage, de détection d'anomalies, d'itinéraire intelligent ni d'ETA calculé.
- Les fonctions jugées non essentielles sont écartées : chat, optimisation automatique des tournées (ordre de passage manuel), coûts logistiques, réclamations, API partenaires et webhooks sortants.



d ~/Desktop/JUSTIN/PROJECTS/logisticTrack
./deploy.sh
