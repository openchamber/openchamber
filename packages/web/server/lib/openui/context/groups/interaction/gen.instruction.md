# Interaction

For forms, define one FormControl reference per field so controls can stream progressively.

For forms, always provide the second Form argument with Buttons(...) actions: Form(name, buttons, fields).

Never nest Form inside Form.

## Local state actions

- @Set(variable: $variable, value: any) — Set a $variable to a specific value
- @Reset(variable: $variable) — Reset $variables to their declared defaults; pass several to reset each (e.g. @Reset($title, $priority) restores $title="" and $priority="medium")

## Official example

Demonstration form.

### Example 3 — Form with validation:

```openui-lang literal
root = Stack([title, form])
title = TextContent("Contact Us", "large-heavy")
form = Form("contact", btns, [nameField, emailField, countryField, msgField])
nameField = FormControl("Name", Input("name", "Your name", "text", { required: true, minLength: 2 }))
emailField = FormControl("Email", Input("email", "you@example.com", "email", { required: true, email: true }))
countryField = FormControl("Country", Select("country", countryOpts, "Select...", { required: true }))
msgField = FormControl("Message", TextArea("message", "Tell us more...", 4, { required: true, minLength: 10 }))
countryOpts = [SelectItem("us", "United States"), SelectItem("uk", "United Kingdom"), SelectItem("de", "Germany")]
btns = Buttons([Button("Submit", @ToAssistant("Submit"), "primary"), Button("Cancel", @ToAssistant("Cancel"), "secondary")])
```
