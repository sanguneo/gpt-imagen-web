// The supervisor owns the process-group lifetime and the cross-restart lock.
// MOSS's scratch path is passed separately from untrusted generator arguments.
export const generationSupervisor = `
  use POSIX qw(WNOHANG);
  use Fcntl qw(:flock);
  use File::Path qw(remove_tree);
  my $seconds = shift @ARGV; my $scratch = shift @ARGV;
  my $owner = getppid(); my $pid;
  sub abort_group {
    remove_tree($scratch) if length $scratch;
    kill 'KILL', -$$;
  }
  $SIG{ALRM} = sub { abort_group(); };
  alarm $seconds;
  my $go = <STDIN>; exit 1 unless defined $go;
  open(my $guard, ">>", shift @ARGV) or die "generation lock open failed";
  flock($guard, LOCK_EX) or die "generation lock failed";
  if (getppid() != $owner) { abort_group(); }
  $pid = fork(); die "fork failed" unless defined $pid;
  if (!$pid) { exec @ARGV; die "exec failed"; }
  while (1) {
    my $done = waitpid($pid, WNOHANG);
    if ($done == $pid) { my $code = $?; exit(($code & 127) ? 128 + ($code & 127) : $code >> 8); }
    if (getppid() != $owner) { abort_group(); }
    select undef, undef, undef, 0.2;
  }`;
