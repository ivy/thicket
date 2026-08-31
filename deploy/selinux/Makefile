# Builds the policy module. Needs checkpolicy and policycoreutils, and
# deliberately not selinux-policy-devel: the module is written in the base
# language so it compiles on a host with no policy headers.
#
#   make            build thicket.pp
#   sudo make install   build, install, and label what is already on disk
#   sudo make permissive  put the three domains in permissive mode
#   sudo make enforce     take them out of it
NAME = thicket
DOMAINS = thicket_netd_t thicket_bridge_t thicket_phone_t

all: $(NAME).pp

$(NAME).mod: $(NAME).te
	checkmodule -M -m -o $@ $<

$(NAME).pp: $(NAME).mod $(NAME).fc
	semodule_package -o $@ -m $(NAME).mod -f $(NAME).fc

install: $(NAME).pp
	semodule -i $(NAME).pp
	# Label what is already there; a module install does not relabel by itself.
	restorecon -RF /opt/thicket /etc/thicket /var/lib/thicket* /run/thicket 2>/dev/null || true

# The bring-up path: run permissive, soak under real traffic, read the AVCs,
# fold them in, then enforce. A domain that goes straight to enforcing tells
# you what it needed by failing.
permissive:
	for d in $(DOMAINS); do semanage permissive -a $$d; done

enforce:
	for d in $(DOMAINS); do semanage permissive -d $$d; done

uninstall:
	semodule -r $(NAME)

clean:
	rm -f $(NAME).mod $(NAME).pp

.PHONY: all install permissive enforce uninstall clean
