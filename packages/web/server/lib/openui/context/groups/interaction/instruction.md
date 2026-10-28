# OpenChamber actions

Buttons require explicit actions. @ToAssistant(message: string, context?: any)
submits intent and enclosing form values; inline it starts a new user turn, while
in openui.prompt it completes the waiting call. @OpenUrl(url: string) opens a
validated HTTP(S) URL through the host. Each must be the sole step in its action.
Action([@Set($var, value), @Reset($other)]) combines local steps in order.
Keep field values until host acceptance; confirm submission only after acceptance.
The official example's Cancel sends a message to the assistant.
Read advanced for expressions and derived values.
