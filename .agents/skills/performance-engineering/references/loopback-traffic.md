# Measuring the installed app's network traffic

For reports like "the app moves gigabytes a day". The desktop app's server talks to its own OpenCode over loopback, and the renderer's requests reach OpenCode through the server's proxy. macOS monitors count loopback, each byte both as sent and as received, so a report with equal upload and download points at loopback before anything leaves the machine.

Measure the user's running app as it is. Relaunching it with an inspector or a debugging port ends every agent session running inside it, your own included.

## Which process moves the bytes

Per-process deltas over one minute, no sudo:

```sh
nettop -P -d -L 2 -s 60 -n -x -t loopback -J bytes_in,bytes_out
```

The second block of output is the delta. Repeat with `-t external` for real network traffic. Find the PIDs with `ps aux | grep -i -E "openchamber|opencode"`: the main `OpenChamber` process hosts the server, `opencode serve` is OpenCode, and the `OpenChamber Helper` utility process carries the renderer's network.

The server compresses responses to the window, so bytes from OpenCode to the server run about 12 times the bytes the window receives when the renderer is the one asking. Bytes the server takes from OpenCode without a matching share going to the window come from the server itself.

## Which requests

Short-lived connections never show in nettop's per-connection rows, so paths need a capture, which needs sudo. Give the maintainer the command to run in a terminal:

```sh
sudo sh -c 'tcpdump -i lo0 -l -A -s 600 "tcp dst port <port>" > /tmp/oc-lo0.txt 2>/dev/null & sleep 60; kill $!'
```

`<port>` is OpenCode's API port, the first listener from `lsof -nP -a -p <opencode pid> -iTCP -sTCP:LISTEN`. It changes with every launch of the app.

Then count requests by path:

```sh
grep -aoE '(GET|POST|PUT|PATCH|DELETE) /[^ ]+ HTTP' /tmp/oc-lo0.txt | sed -E 's/ HTTP$//; s/(directory|cursor)=[^&]*/\1=X/g' | sort | uniq -c | sort -rn
```

The `user-agent` header says who asked: the Electron one is the renderer, `node` is the server. On one keep-alive connection, the difference between the `ack` numbers of two consecutive requests is the size of the response in between.

## Sizing a response

OpenCode takes basic auth with user `opencode`. The password is in the OpenCode process environment, readable for your own processes:

```sh
PW=$(ps eww -p <opencode pid> | tr ' ' '\n' | grep '^OPENCODE_SERVER_PASSWORD=' | cut -d= -f2-)
curl -s -u "opencode:$PW" -o /dev/null -w "%{size_download}\n" "http://127.0.0.1:<port>/api/session?limit=500"
```

Use it to compare a request against a narrower one the API offers before changing the caller.
