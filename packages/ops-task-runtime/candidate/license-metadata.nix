{ profile ? ./native-profile.json }: let
  sources = [ /nix/store/fr8gfsdbnipx767l86imx1wmkc84175s-source /nix/store/2gi66ywhbj66ssbz5bhgibzafa15m7zy-source ];
  wanted = map (r: r.path) (builtins.fromJSON (builtins.readFile profile)).closure;
  each = src: let
    p = import src {};
    closure = builtins.genericClosure {
      startSet = map (value: {key=value.drvPath; inherit value;}) [p.git p.perlPackages.CGI p.perlPackages.MozillaCA p.perlPackages.libnet p.perlPackages.TermReadKey p.perlPackages.CGIFast p.perlPackages.HTMLTagCloud p.perlPackages.IOSocketSSL p.perlPackages.DigestHMAC p.perlPackages.FCGIProcManager p.perlPackages.NetSSLeay p.perlPackages.FCGI p.perlPackages.CryptURandom p.perlPackages.AuthenSASL p.perlPackages.NetSMTPSSL p.nodejs-slim p.python313 p.bashNonInteractive p.gitFull p.coreutils p.glibc p.gnugrep p.gnused p.mailcap p.gzip p.stdenv.cc.cc];
      operator = row: let d=row.value; in map (value: {key=value.drvPath; inherit value;}) (builtins.filter (x: builtins.isAttrs x && x ? drvPath) ([ (d.stdenv.cc.cc or null) ] ++ (d.buildInputs or []) ++ (d.propagatedBuildInputs or []) ++ (d.nativeBuildInputs or []) ++ (d.propagatedNativeBuildInputs or [])));
    };
    rows = builtins.concatMap (r: map (output: let d=r.value; path=d.${output}.outPath; in {inherit path; source=toString src; name=d.name or "unknown"; position=d.meta.position or null; license=d.meta.license or null; homepage=d.meta.homepage or null;}) (r.value.outputs or ["out"])) closure;
  in builtins.filter (r: builtins.elem r.path wanted) rows;
in builtins.concatMap each sources
