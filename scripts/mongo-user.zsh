#!/usr/bin/env zsh
# Creates (or resets the password of) the website's own Mongo user,
# bha_service, with read/write access to the bha database only, on both
# servers with the same password, so one MONGODB_URI_BHA in Bitwarden works
# for the preview (mini, which requires logins) and live (sky, which doesn't
# yet, but will if logins are turned on).
#
#   scripts/mongo-user.zsh
#
# The new address is written to ~/.config/bha-website/MONGODB_URI_BHA (only
# readable by you) and never printed: paste it into the Bitwarden item
# MONGODB_URI_BHA, delete the file, then deploy.
set -euo pipefail

user=bha_service
database=bha
out="$HOME/.config/bha-website/MONGODB_URI_BHA"

umask 077
password="$(openssl rand -hex 32)"

# The password goes over ssh's stdin, never on a command line.
provision() {
  local host=$1 mongosh=$2 admin_login=$3
  print -r -- "$password" | ssh -o ConnectTimeout=10 "$host" \
    "BHA_DB_PASSWORD=\$(cat) ADMIN_LOGIN='$admin_login' $mongosh --quiet --norc --eval '
      const admin = db.getSiblingDB(\"admin\");
      if (process.env.ADMIN_LOGIN) {
        const [file, name] = process.env.ADMIN_LOGIN.split(\":\");
        admin.auth(name, require(\"fs\").readFileSync(file.replace(/^~/, process.env.HOME), \"utf8\").trim());
      }
      const bha = db.getSiblingDB(\"$database\");
      const roles = [{ role: \"readWrite\", db: \"$database\" }];
      if (bha.getUser(\"$user\")) bha.updateUser(\"$user\", { pwd: process.env.BHA_DB_PASSWORD, roles });
      else bha.createUser({ user: \"$user\", pwd: process.env.BHA_DB_PASSWORD, roles });
      if (!bha.auth(\"$user\", process.env.BHA_DB_PASSWORD)) quit(1);
      print(\"$host: $user can log in to $database\");
    '"
}

# Mini requires logins; its admin password is kept there by the train-track-planner setup.
provision mini /opt/homebrew/bin/mongosh '~/.local/share/train-track-planner/mongodb-admin.password:planner_admin'
provision sky mongosh ''

mkdir -p "${out:h}"
print -r -- "mongodb://$user:$password@127.0.0.1:27017/$database?authSource=$database" > "$out"
chmod 600 "$out"
print "Saved the new MONGODB_URI_BHA to $out. Paste it into Bitwarden, then delete the file."
