import UIKit

/// Receives what the system share sheet handed over — files, a link or a paragraph — stages it
/// in the App Group inbox and brings the app forward. The page then attaches the files to a new
/// session draft and types in the text; the app itself never opens a draft from here.
final class ShareViewController: UIViewController {
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        let label = UILabel()
        label.text = "Adding to OpenChamber…"
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.textColor = .secondaryLabel
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { await receive() }
    }

    private func receive() async {
        do {
            let directory = try ShareInbox.resetDirectory()
            let providers = ShareStaging.providers(in: extensionContext)
            let text = await ShareStaging.text(from: providers)
            let records = await ShareStaging.records(from: providers, in: directory)
            guard !records.isEmpty || text != nil else { throw ShareInboxError.noContent }
            try ShareInbox.write(records, text: text, in: directory)
            NSLog(
                "[ShareInbox] staged files=[%@] text=%d",
                records.map { "\($0.rejected ?? "ok") \($0.name) (\($0.mimeType), \($0.size))" }
                    .joined(separator: ", "),
                text?.count ?? 0
            )
            openApp()
            extensionContext?.completeRequest(returningItems: nil)
        } catch {
            presentFailure(error)
        }
    }

    /// The share sheet cannot open the containing app through `UIApplication.shared` (it is
    /// unavailable in extensions), and `extensionContext.open` only works for some extension
    /// points. Both are attempted; neither waits, because a share extension that hangs here
    /// would be killed with the file already staged. If both fail the inbox stays put and the
    /// app takes it the next time it becomes active.
    private func openApp() {
        extensionContext?.open(ShareInbox.openURL, completionHandler: nil)

        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                application.open(ShareInbox.openURL, options: [:], completionHandler: nil)
                return
            }
            responder = current.next
        }
    }

    private func presentFailure(_ error: Error) {
        let message: String
        switch error as? ShareInboxError {
        case .noContent:
            message = "Nothing could be shared with OpenChamber."
        default:
            message = "OpenChamber couldn't receive what you shared."
        }
        NSLog("[ShareInbox] failed %@", String(describing: error))
        let alert = UIAlertController(title: "OpenChamber", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        present(alert, animated: true)
    }
}
