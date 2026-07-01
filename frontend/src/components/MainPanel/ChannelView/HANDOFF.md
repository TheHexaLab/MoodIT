# Brancher le backend + WebSockets sur le chat (ChannelView)

Tout le front est prêt. **Tu ne touches que `Dashboard.tsx` + `services/channelSocket.ts`.**
Le hook (`useChannelMessages`), `ChannelView` et `MainPanel` ne bougent pas.

## Flux de données

```
Dashboard
  ├─ onFetchMessages / onSendMessage / onEditMessage / onDeleteMessage   (API)
  ├─ socket  (WebSocket)
  └─▶ MainPanel ─▶ ChannelView ─▶ useChannelMessages  ← SOURCE DE VÉRITÉ
                                     • une seule liste `messages`
                                     • optimiste + rollback
                                     • dédup via clientMsgId
                                     • applyIncoming* ← socket
```

`useChannelMessages` détient **une seule liste de messages**. Elle est alimentée par :
1. le **chargement initial** (`onFetchMessages`),
2. les **actions locales** optimistes (`sendMessage` / `editMessage` / `deleteMessage`),
3. les **évènements temps réel** (`applyIncomingMessage` / `Edit` / `Delete`, branchés sur le socket).

## Les 4 callbacks API à remplir (dans `Dashboard.tsx`)

Actuellement ce sont des mocks (`setTimeout` + `console.log`). Remplace les corps :

| Callback | Verbe | Doit faire / renvoyer |
|---|---|---|
| `handleFetchMessages(channelId)` | `GET /channels/:id/messages` | renvoyer `ChannelMessage[]` |
| `handleSendMessage(content, parentId, clientMessageId)` | `POST` | **renvoyer le message persisté** (id réel + même `clientMsgId`) |
| `handleEditMessage(messageId, content)` | `PATCH` | renvoyer le message persisté (optionnel) |
| `handleDeleteMessage(messageId)` | `DELETE` | rien |

Les états `loading` / erreur de chargement / `pending` / erreurs d'action + le rollback
sont **déjà gérés** par le hook. Tu n'écris que les appels réseau.

## Le WebSocket

Un scaffold prêt : **`src/services/channelSocket.ts`** (`createChannelSocket`).
Remplis-y l'URL + le format des évènements serveur, puis dans `Dashboard.tsx` :

```ts
const socket = useMemo(() => createChannelSocket(import.meta.env.VITE_WS_URL, getAuthToken), []);
// …
<MainPanel … socket={socket} />   // remplace socket={mockMessageSocket}
```

Le contrat (`ChannelSocket`) : `subscribe(channelId, { onMessage, onEdit, onDelete }) => unsubscribe`.
Le hook s'abonne au montage du canal et **se désabonne automatiquement** au changement
de canal (grâce au remount par `key`).

## ⚠️ 2 pièges à connaître

1. **`onSendMessage` doit renvoyer le message persisté** (avec l'`id` serveur réel).
   Le hook remplace alors la version optimiste. Le serveur doit aussi **renvoyer le
   `clientMsgId`** dans le broadcast WS → c'est ce qui évite d'afficher ton propre
   message en double (dédup déjà codée dans `applyIncomingMessage`).

2. **Reconnexion = messages manqués.** À la reconnexion du socket, re-`join` les rooms
   **et refetch les messages manqués** depuis le dernier connu (TODO marqué dans
   `channelSocket.ts > onopen`). Sinon trou dans l'historique après une coupure.

## Outil de DEV (à retirer ensuite)

Le dossier `src/dev/` (mock socket + menu clic-droit sur l'icône de l'app) sert à
tester la réception sans backend. À supprimer une fois le vrai socket branché :
retirer l'import dans `Dashboard.tsx` et le wrapper `WsTestContextMenu` dans `ProgramMenu`.
