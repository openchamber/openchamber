use anyhow::Result;
use std::path::Path;
use std::process::Command;

/// Abstraction over SSH command execution, enabling test mocking.
pub(crate) trait SshRunner {
    /// Build an SSH command with the given arguments.
    /// If `session_dir` is provided, sets it as the working directory.
    fn build_command(&self, args: &[String], session_dir: Option<&Path>) -> Command;

    /// Run a remote command via SSH using the provided control path.
    /// The command executes the given script with a timeout.
    fn run_remote(
        &self,
        parsed_args: &[String],
        control_path: &Path,
        script: &str,
        timeout_sec: u16,
    ) -> Result<String>;
}

/// Production SSH runner that executes real ssh commands.
pub(crate) struct RealSshRunner;

impl SshRunner for RealSshRunner {
    fn build_command(&self, args: &[String], session_dir: Option<&Path>) -> Command {
        let mut cmd = Command::new("ssh");
        cmd.args(args);
        if let Some(dir) = session_dir {
            cmd.current_dir(dir);
        }
        cmd
    }

    fn run_remote(
        &self,
        parsed_args: &[String],
        control_path: &Path,
        script: &str,
        timeout_sec: u16,
    ) -> Result<String> {
        // Delegate to the existing run_remote_command logic in process.rs
        // For now, this is a thin wrapper. The actual implementation stays in process.rs.
        crate::remote_ssh::process::run_remote_command_direct(
            parsed_args,
            control_path,
            script,
            timeout_sec,
        )
    }
}
