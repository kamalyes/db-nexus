import { DatabaseDriverId } from '../core/types'
import { MySQLDriver } from './mysql'

export class MariaDBDriver extends MySQLDriver {
  override id: DatabaseDriverId = 'mariadb'
  override displayName = 'MariaDB'
}
