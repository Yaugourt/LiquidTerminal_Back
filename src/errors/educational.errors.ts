// Base error class for educational resources
export class EducationalError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode: number = 500, code: string = 'EDUCATIONAL_ERROR') {
    super(message);
    this.name = 'EducationalError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Educational Category Errors
export class EducationalCategoryError extends EducationalError {
  constructor(message: string, statusCode: number = 500, code: string = 'EDUCATIONAL_CATEGORY_ERROR') {
    super(message, statusCode, code);
    this.name = 'EducationalCategoryError';
  }
}

export class EducationalCategoryNotFoundError extends EducationalCategoryError {
  constructor(message: string = 'Educational category not found') {
    super(message, 404, 'EDUCATIONAL_CATEGORY_NOT_FOUND');
  }
}

export class EducationalCategoryAlreadyExistsError extends EducationalCategoryError {
  constructor(message: string = 'Educational category with this name already exists') {
    super(message, 400, 'EDUCATIONAL_CATEGORY_ALREADY_EXISTS');
  }
}

export class EducationalCategoryValidationError extends EducationalCategoryError {
  constructor(message: string = 'Invalid educational category data') {
    super(message, 400, 'EDUCATIONAL_CATEGORY_VALIDATION_ERROR');
  }
}

// Educational Resource Errors
export class EducationalResourceError extends EducationalError {
  constructor(message: string, statusCode: number = 500, code: string = 'EDUCATIONAL_RESOURCE_ERROR') {
    super(message, statusCode, code);
    this.name = 'EducationalResourceError';
  }
}

export class EducationalResourceNotFoundError extends EducationalResourceError {
  constructor(message: string = 'Educational resource not found') {
    super(message, 404, 'EDUCATIONAL_RESOURCE_NOT_FOUND');
  }
}

export class EducationalResourceAlreadyExistsError extends EducationalResourceError {
  constructor(message: string = 'Educational resource with this URL already exists') {
    super(message, 400, 'EDUCATIONAL_RESOURCE_ALREADY_EXISTS');
  }
}

export class EducationalResourceValidationError extends EducationalResourceError {
  constructor(message: string = 'Invalid educational resource data') {
    super(message, 400, 'EDUCATIONAL_RESOURCE_VALIDATION_ERROR');
  }
}

// Educational Resource Category Assignment Errors
export class EducationalResourceCategoryError extends EducationalError {
  constructor(message: string, statusCode: number = 500, code: string = 'EDUCATIONAL_RESOURCE_CATEGORY_ERROR') {
    super(message, statusCode, code);
    this.name = 'EducationalResourceCategoryError';
  }
}

export class EducationalResourceCategoryNotFoundError extends EducationalResourceCategoryError {
  constructor(message: string = 'Educational resource category assignment not found') {
    super(message, 404, 'EDUCATIONAL_RESOURCE_CATEGORY_NOT_FOUND');
  }
}

export class EducationalResourceCategoryAlreadyExistsError extends EducationalResourceCategoryError {
  constructor(message: string = 'Resource is already assigned to this category') {
    super(message, 400, 'EDUCATIONAL_RESOURCE_CATEGORY_ALREADY_EXISTS');
  }
}

export class EducationalResourceCategoryValidationError extends EducationalResourceCategoryError {
  constructor(message: string = 'Invalid resource category assignment data') {
    super(message, 400, 'EDUCATIONAL_RESOURCE_CATEGORY_VALIDATION_ERROR');
  }
}

// Permission/Authorization Errors
export class EducationalPermissionError extends EducationalError {
  constructor(message: string = 'You do not have permission to perform this action') {
    super(message, 403, 'EDUCATIONAL_PERMISSION_DENIED');
  }
}

export class EducationalUnauthorizedError extends EducationalError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'EDUCATIONAL_UNAUTHORIZED');
  }
}

// URL/Link related errors
export class EducationalUrlError extends EducationalResourceError {
  constructor(message: string = 'Invalid or inaccessible URL') {
    super(message, 400, 'EDUCATIONAL_INVALID_URL');
  }
}

export class EducationalUrlFetchError extends EducationalResourceError {
  constructor(message: string = 'Failed to fetch URL metadata') {
    super(message, 400, 'EDUCATIONAL_URL_FETCH_ERROR');
  }
}

// Content Filter Errors
export class ContentFilterError extends EducationalResourceError {
  constructor(reason: string, details?: string) {
    super(details ? `Content rejected: ${reason} - ${details}` : `Content rejected: ${reason}`, 400, 'CONTENT_FILTERED');
  }
}

// Resource Report Errors
export class DuplicateReportError extends EducationalError {
  constructor(message: string = 'You have already reported this resource') {
    super(message, 409, 'DUPLICATE_REPORT');
  }
}

export class ResourceReportNotFoundError extends EducationalError {
  constructor(message: string = 'Resource report not found') {
    super(message, 404, 'RESOURCE_REPORT_NOT_FOUND');
  }
}

// Moderation Errors
export class ResourceAlreadyReviewedError extends EducationalResourceError {
  constructor(message: string = 'This resource has already been reviewed') {
    super(message, 400, 'RESOURCE_ALREADY_REVIEWED');
  }
}
