# Received page client

## Ownership

This module owns received-link parsing and the received-page API contract. The server owns keys, PIN verification, decryption and all relay calls.

## Invariants

- Only configured relay bases admit links, and the server checks them again. Every share-key fragment is removed from sent, queued and saved text even on an unaccepted host, preventing a restored draft or alternate send path from leaking a key.
- The client hands a link to the server once and thereafter addresses only its received ID. Keys and PINs do not enter persistent drafts, and enterprise mode disables every operation except capability discovery.
- Malformed list rows drop independently, failed reads throw, and unknown statuses require no action. A rejected PIN is an explicit answer with attempts remaining, distinct from transport failure; answers remain one-shot and server-sealed.
