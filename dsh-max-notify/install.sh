#!/usr/bin/env bash
# Устанавливает dsh-max-notify в профиль DeepSeek Harness.
#
#   ./install.sh                     # профиль web (по умолчанию)
#   ./install.sh tui                 # другой профиль
#   DSH_HOME=$DSH_HOME ./install.sh # явный DSH_HOME
#
# Плагин ставится как bundle: dsh plugin add записывает link:-зависимость и
# добавляет пакет в dsh.profile.bundles, после чего его cordis.patch.yml
# вставляет строку max-notify в дерево плагинов профиля.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-${DSH_PROFILE:-web}}"
DSH_BIN="${DSH_BIN:-dsh}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

if [[ ! -f "$HERE/cordis.patch.yml" || ! -f "$HERE/index.js" ]]; then
  echo "error: $HERE is not the dsh-max-notify package (run install.sh from the package dir)" >&2
  exit 1
fi

echo "==> DSH home:  $DSH_HOME_DIR"
echo "==> profile:   $PROFILE"
echo "==> plugin:    $HERE"

if [[ ! -d "$DSH_HOME_DIR/profiles/$PROFILE" ]]; then
  echo "==> профиль ещё не создан — DSH инициализирует его из шаблона при установке"
fi

"$DSH_BIN" plugin --profile "$PROFILE" add "link:$HERE"

cat <<EOF

Готово. Проверка состава профиля:
  DSH_HOME=$DSH_HOME_DIR $DSH_BIN --profile $PROFILE --dump-config | grep -A12 'id: max-notify'

Конфиг плагина: $HERE/cordis.patch.yml
  - botTokenFile: /path/to/MaxBot/.env   (токен MAX_BOT_TOKEN)
  - chatId: 123456789                 (получатель)
  - включить dry-run: dryRun: true

Если профиль уже был запущен, DSH обычно пересобирает его на лету (HMR);
иначе перезапустите приложение профиля (например, service dsh-web restart).
EOF
