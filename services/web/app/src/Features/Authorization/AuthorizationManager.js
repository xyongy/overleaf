const { callbackify } = require('util')
const { ObjectId } = require('mongodb')
const CollaboratorsGetter = require('../Collaborators/CollaboratorsGetter')
const CollaboratorsHandler = require('../Collaborators/CollaboratorsHandler')
const ProjectGetter = require('../Project/ProjectGetter')
const { User } = require('../../models/User')
const PrivilegeLevels = require('./PrivilegeLevels')
const TokenAccessHandler = require('../TokenAccess/TokenAccessHandler')
const PublicAccessLevels = require('./PublicAccessLevels')
const Errors = require('../Errors/Errors')

function isRestrictedUser(userId, privilegeLevel, isTokenMember) {
  if (privilegeLevel === PrivilegeLevels.NONE) {
    return true
  }
  return (
    privilegeLevel === PrivilegeLevels.READ_ONLY && (isTokenMember || !userId)
  )
}

async function isRestrictedUserForProject(userId, projectId, token) {
  const privilegeLevel = await getPrivilegeLevelForProject(
    userId,
    projectId,
    token
  )
  const isTokenMember = await CollaboratorsHandler.promises.userIsTokenMember(
    userId,
    projectId
  )
  return isRestrictedUser(userId, privilegeLevel, isTokenMember)
}

async function getPublicAccessLevel(projectId) {
  if (!ObjectId.isValid(projectId)) {
    throw new Error('invalid project id')
  }

  // Note, the Project property in the DB is `publicAccesLevel`, without the second `s`
  const project = await ProjectGetter.promises.getProject(projectId, {
    publicAccesLevel: 1,
  })
  if (!project) {
    throw new Errors.NotFoundError(`no project found with id ${projectId}`)
  }
  return project.publicAccesLevel
}

/**
 * Get the privilege level that the user has for the project.
 *
 * @param userId - The id of the user that wants to access the project.
 * @param projectId - The id of the project to be accessed.
 * @param {Object} opts
 * @param {boolean} opts.ignoreSiteAdmin - Do not consider whether the user is
 *     a site admin.
 * @param {boolean} opts.ignorePublicAccess - Do not consider the project is
 *     publicly accessible.
 *
 * @returns {string|boolean} The privilege level. One of "owner",
 *     "readAndWrite", "readOnly" or false.
 */
async function getPrivilegeLevelForProject(
  userId,
  projectId,
  token,
  opts = {}
) {
  if (userId) {
    return getPrivilegeLevelForProjectWithUser(userId, projectId, token, opts)
  } else {
    return getPrivilegeLevelForProjectWithoutUser(projectId, token, opts)
  }
}

// User is present, get their privilege level from database
async function getPrivilegeLevelForProjectWithUser(
  userId,
  projectId,
  token,
  opts = {}
) {
  const privilegeLevel = await CollaboratorsGetter.promises.getMemberIdPrivilegeLevel(
    userId,
    projectId
  )
  if (privilegeLevel && privilegeLevel !== PrivilegeLevels.NONE) {
    // The user has direct access
    return privilegeLevel
  }

  if (!opts.ignoreSiteAdmin) {
    const isAdmin = await isUserSiteAdmin(userId)
    if (isAdmin) {
      return PrivilegeLevels.OWNER
    }
  }

  if (!opts.ignorePublicAccess) {
    // Legacy public-access system
    // User is present (not anonymous), but does not have direct access
    const publicAccessLevel = await getPublicAccessLevel(projectId)
    if (publicAccessLevel === PublicAccessLevels.READ_ONLY) {
      return PrivilegeLevels.READ_ONLY
    }
    if (publicAccessLevel === PublicAccessLevels.READ_AND_WRITE) {
      return PrivilegeLevels.READ_AND_WRITE
    }
  }

  return PrivilegeLevels.NONE
}

// User is Anonymous, Try Token-based access
async function getPrivilegeLevelForProjectWithoutUser(
  projectId,
  token,
  opts = {}
) {
  const publicAccessLevel = await getPublicAccessLevel(projectId)
  if (!opts.ignorePublicAccess) {
    if (publicAccessLevel === PublicAccessLevels.READ_ONLY) {
      // Legacy public read-only access for anonymous user
      return PrivilegeLevels.READ_ONLY
    }
    if (publicAccessLevel === PublicAccessLevels.READ_AND_WRITE) {
      // Legacy public read-write access for anonymous user
      return PrivilegeLevels.READ_AND_WRITE
    }
  }
  if (publicAccessLevel === PublicAccessLevels.TOKEN_BASED) {
    return getPrivilegeLevelForProjectWithToken(projectId, token)
  }

  // Deny anonymous user access
  return PrivilegeLevels.NONE
}

async function getPrivilegeLevelForProjectWithToken(projectId, token) {
  // Anonymous users can have read-only access to token-based projects,
  // while read-write access must be logged in,
  // unless the `enableAnonymousReadAndWriteSharing` setting is enabled
  const {
    isValidReadAndWrite,
    isValidReadOnly,
  } = await TokenAccessHandler.promises.validateTokenForAnonymousAccess(
    projectId,
    token
  )
  if (isValidReadOnly) {
    // Grant anonymous user read-only access
    return PrivilegeLevels.READ_ONLY
  }
  if (isValidReadAndWrite) {
    // Grant anonymous user read-and-write access
    return PrivilegeLevels.READ_AND_WRITE
  }
  // Deny anonymous access
  return PrivilegeLevels.NONE
}

async function canUserReadProject(userId, projectId, token) {
  const privilegeLevel = await getPrivilegeLevelForProject(
    userId,
    projectId,
    token
  )
  return [
    PrivilegeLevels.OWNER,
    PrivilegeLevels.READ_AND_WRITE,
    PrivilegeLevels.READ_ONLY,
  ].includes(privilegeLevel)
}

async function canUserWriteProjectContent(userId, projectId, token) {
  const privilegeLevel = await getPrivilegeLevelForProject(
    userId,
    projectId,
    token
  )
  return [PrivilegeLevels.OWNER, PrivilegeLevels.READ_AND_WRITE].includes(
    privilegeLevel
  )
}

async function canUserWriteProjectSettings(userId, projectId, token) {
  const privilegeLevel = await getPrivilegeLevelForProject(
    userId,
    projectId,
    token,
    { ignorePublicAccess: true }
  )
  return [PrivilegeLevels.OWNER, PrivilegeLevels.READ_AND_WRITE].includes(
    privilegeLevel
  )
}

async function canUserRenameProject(userId, projectId, token) {
  const privilegeLevel = await getPrivilegeLevelForProject(
    userId,
    projectId,
    token
  )
  return privilegeLevel === PrivilegeLevels.OWNER
}

async function canUserAdminProject(userId, projectId, token) {
  const privilegeLevel = await getPrivilegeLevelForProject(
    userId,
    projectId,
    token
  )
  return privilegeLevel === PrivilegeLevels.OWNER
}

async function isUserSiteAdmin(userId) {
  if (!userId) {
    return false
  }
  const user = await User.findOne({ _id: userId }, { isAdmin: 1 }).exec()
  return user != null && user.isAdmin === true
}

module.exports = {
  canUserReadProject: callbackify(canUserReadProject),
  canUserWriteProjectContent: callbackify(canUserWriteProjectContent),
  canUserWriteProjectSettings: callbackify(canUserWriteProjectSettings),
  canUserRenameProject: callbackify(canUserRenameProject),
  canUserAdminProject: callbackify(canUserAdminProject),
  getPrivilegeLevelForProject: callbackify(getPrivilegeLevelForProject),
  isRestrictedUser,
  isRestrictedUserForProject: callbackify(isRestrictedUserForProject),
  isUserSiteAdmin: callbackify(isUserSiteAdmin),
  promises: {
    canUserReadProject,
    canUserWriteProjectContent,
    canUserWriteProjectSettings,
    canUserRenameProject,
    canUserAdminProject,
    getPrivilegeLevelForProject,
    isRestrictedUserForProject,
    isUserSiteAdmin,
  },
}
